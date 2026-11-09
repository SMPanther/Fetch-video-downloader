; Forces Windows Explorer to refresh its icon cache right after install/upgrade.
; Without this, a machine that has ever seen a previous build of this app at the
; same install path can keep showing a stale cached icon on shortcuts, even
; after a clean reinstall with a corrected icon file. A plain shell notification
; isn't always enough — Explorer can still serve the old bitmap from its icon
; cache database, so we explicitly clear that too.
!macro customInstall
  nsExec::ExecToLog 'ie4uinit.exe -ClearIconCache'
  nsExec::ExecToLog 'ie4uinit.exe -show'
  System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
