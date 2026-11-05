; Hopp's own words on the installer's first and last pages.
!define MUI_WELCOMEPAGE_TITLE "Welcome to Hopp"
!define MUI_WELCOMEPAGE_TEXT "Hopp is voice and chat for you and your friends: clear voice, servers with text and voice channels, and private messages only you and your friends can read.$\r$\n$\r$\nThis installs Hopp just for you, in a few seconds, with no administrator rights needed. Hopp keeps itself up to date.$\r$\n$\r$\nAfterwards you create your Hopp ID: just a username and a password. No email or phone number.$\r$\n$\r$\nClick Next to continue."
!define MUI_FINISHPAGE_TITLE "Hopp is ready"
!define MUI_FINISHPAGE_TEXT "Hopp is installed and can be found in the Start menu.$\r$\n$\r$\nGot an invite link from a friend? Open it after starting Hopp and you'll land right in their server.$\r$\n$\r$\nHave fun!"

; Hopp keeps running by the clock when its window is closed, so Windows' polite
; "please close" doesn't reach it. Before installing or uninstalling, Hopp is closed
; outright (with its windows), and the installer waits until it has really gone:
; a process still shutting down would otherwise look like one that can't be closed.
!macro HOPP_CLOSE_RUNNING
  !define HoppID ${__LINE__}
  nsExec::Exec 'taskkill /F /T /IM "${MAINBINARYNAME}.exe"'
  Pop $0
  StrCpy $1 0
  hopp_wait_${HoppID}:
    ; "find" succeeds (0) while it's still in the process list.
    nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${MAINBINARYNAME}.exe" /NH | find /I "${MAINBINARYNAME}.exe"'
    Pop $0
    Pop $2
    StrCmp $0 "0" 0 hopp_gone_${HoppID}
    IntOp $1 $1 + 1
    ; Up to 40 checks, 200 ms apart (8 seconds).
    IntCmp $1 40 hopp_gone_${HoppID} 0 hopp_gone_${HoppID}
    Sleep 200
    Goto hopp_wait_${HoppID}
  hopp_gone_${HoppID}:
  Sleep 300
  !undef HoppID
!macroend

; Tauri's own check asks Windows what has Hopp's file open, and gives up if any of it
; can't be closed. But antivirus (McAfee, Norton…) keeps the file open to scan it and
; can't be closed, so updates failed with "Failed to kill Hopp". This check looks for
; Hopp itself only: closes it if it's there, and asks for help if it won't go.
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executablePath productName
  !define HoppCheck ${__LINE__}
  hopp_check_${HoppCheck}:
    nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${MAINBINARYNAME}.exe" /NH | find /I "${MAINBINARYNAME}.exe"'
    Pop $0
    Pop $2
    StrCmp $0 "0" 0 hopp_check_done_${HoppCheck}
    nsExec::Exec 'taskkill /F /T /IM "${MAINBINARYNAME}.exe"'
    Pop $0
    Sleep 1500
    nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${MAINBINARYNAME}.exe" /NH | find /I "${MAINBINARYNAME}.exe"'
    Pop $0
    Pop $2
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
