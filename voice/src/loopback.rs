//! The computer's sound, for a shared screen: everything playing on this computer except Hopp
//! itself (so the people watching never hear their own voices back, nor Hopp's sounds).
//!
//! Windows lets an app capture all audio except one process tree ("process loopback",
//! Windows 10 2004 and later), which is exactly this. Delivers 10 ms frames of 48 kHz stereo.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::Arc;

/// Samples per channel in one 10 ms frame at 48 kHz.
pub const FRAME: usize = 480;

/// Captures until `stop` is set; each 10 ms of stereo (interleaved, 960 values) goes to `out`.
/// Returns an error at once if this Windows can't capture the computer's sound.
pub fn capture(out: SyncSender<Vec<f32>>, stop: Arc<AtomicBool>) -> anyhow::Result<std::thread::JoinHandle<()>> {
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<anyhow::Result<()>>();
    let thread = std::thread::Builder::new().name("strom-loopback".into()).spawn(move || {
        #[cfg(windows)]
        {
            if let Err(e) = imp::run(out, stop, &ready_tx) {
                let _ = ready_tx.send(Err(e));
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (out, stop);
            let _ = ready_tx.send(Err(anyhow::anyhow!("sharing the computer's sound needs Windows")));
        }
    })?;
    match ready_rx.recv() {
        Ok(Ok(())) => Ok(thread),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => Err(anyhow::anyhow!("the computer's sound couldn't be captured")),
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::mpsc::Sender;
    use windows::core::{implement, Interface, Ref, HRESULT};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::Media::Audio::{
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
        IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT,
        AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
        AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
        AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
    };
    use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, BLOB, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{CreateEventW, GetCurrentProcessId, SetEvent, WaitForSingleObject};
    use windows::Win32::System::Variant::VT_BLOB;

    /// Told when Windows has the capture ready.
    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct Activated(HANDLE);

    impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
        fn ActivateCompleted(&self, _op: Ref<IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
            unsafe { SetEvent(self.0) }
        }
    }

    const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;

    pub fn run(out: SyncSender<Vec<f32>>, stop: Arc<AtomicBool>, ready: &Sender<anyhow::Result<()>>) -> anyhow::Result<()> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            let result = capture_loop(out, &stop, ready);
            CoUninitialize();
            result
        }
    }

    unsafe fn capture_loop(out: SyncSender<Vec<f32>>, stop: &AtomicBool, ready: &Sender<anyhow::Result<()>>) -> anyhow::Result<()> {
        // Everything but us (and the web view, which runs as our child).
        let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: GetCurrentProcessId(),
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };
        // Never "cleared": its blob points at `params` here, which isn't Windows' to free.
        let prop = std::mem::ManuallyDrop::new(PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_BLOB,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        blob: BLOB { cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32, pBlobData: &mut params as *mut _ as *mut u8 },
                    },
                }),
            },
        });
        let done = CreateEventW(None, false, false, None)?;
        let handler: IActivateAudioInterfaceCompletionHandler = Activated(done).into();
        let op = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&*prop as *const PROPVARIANT), &handler)?;
        if WaitForSingleObject(done, 5000) != WAIT_OBJECT_0 {
            let _ = CloseHandle(done);
            anyhow::bail!("Windows didn't start capturing the computer's sound");
        }
        let _ = CloseHandle(done);
        let mut hr = HRESULT(0);
        let mut unknown = None;
        op.GetActivateResult(&mut hr, &mut unknown)?;
        hr.ok()?;
        let client: IAudioClient = unknown.ok_or_else(|| anyhow::anyhow!("no audio client"))?.cast()?;

        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
            nChannels: 2,
            nSamplesPerSec: 48_000,
            nAvgBytesPerSec: 48_000 * 2 * 4,
            nBlockAlign: 2 * 4,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            200_000, // 20 ms, in 100 ns units
            0,
            &format,
            None,
        )?;
        let wake = CreateEventW(None, false, false, None)?;
        client.SetEventHandle(wake)?;
        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        let _ = ready.send(Ok(()));

        // Whatever comes, in 10 ms frames.
        let mut pending: Vec<f32> = Vec::with_capacity(FRAME * 4);
        while !stop.load(Ordering::Relaxed) {
            WaitForSingleObject(wake, 100);
            loop {
                let frames = capture.GetNextPacketSize()?;
                if frames == 0 {
                    break;
                }
                let mut data = std::ptr::null_mut();
                let mut count = 0u32;
                let mut flags = 0u32;
                capture.GetBuffer(&mut data, &mut count, &mut flags, None, None)?;
                let n = count as usize * 2;
                if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                    pending.extend(std::iter::repeat_n(0.0, n));
                } else {
                    pending.extend_from_slice(std::slice::from_raw_parts(data as *const f32, n));
                }
                capture.ReleaseBuffer(count)?;
            }
            while pending.len() >= FRAME * 2 {
                let frame: Vec<f32> = pending.drain(..FRAME * 2).collect();
                // A full queue means the sender is behind: this frame goes, rather than delay.
                let _ = out.try_send(frame);
            }
        }
        let _ = client.Stop();
        let _ = CloseHandle(wake);
        Ok(())
    }
}
