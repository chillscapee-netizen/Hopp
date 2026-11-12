; A modern look: Windows' own font of today instead of the old default, the logo on the right
; of the header, and room for the sharper artwork (drawn at twice the size, so it stays crisp
; on high-resolution screens).
SetFont "Segoe UI" 9
!define MUI_HEADERIMAGE_RIGHT
!define MUI_BGCOLOR "FFFFFF"

; The terms: read, and accepted with a tick (Next stays off until then).
!define MUI_LICENSEPAGE_CHECKBOX
!define MUI_LICENSEPAGE_CHECKBOX_TEXT "I accept the terms of use"
!define MUI_LICENSEPAGE_TEXT_TOP "They're short. Scroll to read them all."

; Where Hopp goes: yours to choose.
!define MUI_DIRECTORYPAGE_TEXT_TOP "Hopp will be installed in the folder below. To pick another one, click Browse. Hopp installs just for you, so no administrator rights are needed."

; Hopp's own words on the installer's first and last pages.
!define MUI_WELCOMEPAGE_TITLE "Welcome to Hopp"
!define MUI_WELCOMEPAGE_TEXT "Hopp is voice and chat for you and your friends: clear voice, servers with text and voice channels, and private messages only you and your friends can read.$\r$\n$\r$\nThis installs Hopp just for you, in a few seconds, with no administrator rights needed. Hopp keeps itself up to date.$\r$\n$\r$\nAfterwards you create your Hopp ID: just a username and a password. No email or phone number.$\r$\n$\r$\nClick Next to continue."
!define MUI_FINISHPAGE_TITLE "Hopp is ready"
!define MUI_FINISHPAGE_TEXT "Hopp is installed and can be found in the Start menu.$\r$\n$\r$\nGot an invite link from a friend? Open it after starting Hopp and you'll land right in their server.$\r$\n$\r$\nHave fun!"

; Hopp keeps running by the clock when its window is closed, so it has to be closed before
; installing over it. This is done with the installer's own plugin (it looks for Hopp among
; this user's programs and closes only that), never by starting command prompts or
; taskkill: those look like what harmful programs do, and antivirus flags installers for it.
; Results from the plugin: 0 means found / closed.
!macro HOPP_CLOSE_RUNNING
  !define HoppID ${__LINE__}
  StrCpy $1 0
  hopp_look_${HoppID}:
    nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
    Pop $0
    StrCmp $0 "0" 0 hopp_gone_${HoppID}
    nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
    Pop $0
    IntOp $1 $1 + 1
    ; Up to 40 tries, 200 ms apart (8 seconds).
    IntCmp $1 40 hopp_gone_${HoppID} 0 hopp_gone_${HoppID}
    Sleep 200
    Goto hopp_look_${HoppID}
  hopp_gone_${HoppID}:
  Sleep 300
  !undef HoppID
!macroend

; Tauri's own check asks Windows what has Hopp's file open, and gives up if any of it
; can't be closed. But antivirus keeps the file open to scan it and can't be closed, so
; updates failed with "Failed to kill Hopp". This check looks for Hopp itself only:
; closes it if it's there, and asks for help if it won't go.
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executablePath productName
  !define HoppCheck ${__LINE__}
  hopp_check_${HoppCheck}:
    !insertmacro HOPP_CLOSE_RUNNING
    nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
    Pop $0
    StrCmp $0 "0" 0 hopp_check_done_${HoppCheck}
    IfSilent hopp_check_abort_${HoppCheck}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${productName} is still running and couldn't be closed.$\r$\n$\r$\nRight-click the Hopp icon by the clock and choose Quit, then press Retry." IDRETRY hopp_check_${HoppCheck}
    hopp_check_abort_${HoppCheck}:
    Abort
  hopp_check_done_${HoppCheck}:
  !undef HoppCheck
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro HOPP_CLOSE_RUNNING
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro HOPP_CLOSE_RUNNING
!macroend

; After installing or updating: Windows keeps old icons for pinned and shortcut Hopp in a cache,
; so a new logo would show by the clock but not in the taskbar. This asks Windows to refresh
; them, with its own call for exactly that (no other program is started).
!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
