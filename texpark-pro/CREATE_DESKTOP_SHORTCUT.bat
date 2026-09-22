@echo off
set "TARGET=%~dp0START_APP.bat"
set "SHORTCUT=%USERPROFILE%\Desktop\Texpark Pro Business Manager.lnk"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut('%SHORTCUT%'); $s.TargetPath='%TARGET%'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%SystemRoot%\System32\SHELL32.dll,220'; $s.Save()"
echo Desktop shortcut created: Texpark Pro Business Manager
pause
