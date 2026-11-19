!include "getProcessInfo.nsh"
Var pid

; Older installed builds ignore --quit-for-update, so they can stay alive as
; invisible tray processes and block the upgrade. Force-close them first, then
; let electron-builder verify that no instance remains before replacing files.
!macro customCheckAppRunning
  nsExec::ExecToLog 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 1000
  !insertmacro _CHECK_APP_RUNNING
!macroend
