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

; The app keeps everything it writes in "data" inside its own folder (settings, .env,
; logs, caches). An update replaces the program and keeps that folder; uninstalling
; removes the whole folder, so nothing of the app stays on the system.
!macro customRemoveFiles
  ${if} ${isUpdated}
    ClearErrors
    FindFirst $R0 $R1 "$INSTDIR\*.*"
    ${DoUntil} ${Errors}
      ${If} $R1 != "."
      ${AndIf} $R1 != ".."
      ${AndIf} $R1 != "data"
        ${If} ${FileExists} "$INSTDIR\$R1\*.*"
          RMDir /r "$INSTDIR\$R1"
        ${Else}
          Delete "$INSTDIR\$R1"
        ${EndIf}
      ${EndIf}
      ClearErrors
      FindNext $R0 $R1
    ${Loop}
    FindClose $R0
  ${else}
    RMDir /r "$INSTDIR"
  ${endif}
!macroend
