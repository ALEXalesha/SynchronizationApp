; Inno Setup script for SyncGlass C# (WPF).
; Packages the self-contained single-file csharp\dist\SyncGlass.exe into an installer
; with Start Menu + optional desktop shortcuts and an uninstaller.
; Build:  ISCC.exe csharp\installer\SyncGlass.iss
;
; The Electron version installs as "SyncGlass" through its own NSIS installer. This one
; is "SyncGlass C#" with its own AppId and folder, so both can live side by side. They
; share %APPDATA%\SyncGlass and a single-instance lock, so only one runs at a time.
; The version must match package.json and SyncGlass.Wpf.csproj (ReleaseTests checks it).

#define MyAppName "SyncGlass C#"
#define MyAppVersion "1.2.4"
#define MyAppPublisher "SyncGlass"
#define MyAppExeName "SyncGlass.exe"

[Setup]
AppId={{4C2B7E91-3A6D-4F0B-8E15-9D7A2C6B1F38}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\SyncGlass CSharp
DefaultGroupName=SyncGlass C#
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=SyncGlass-CSharp-Setup-{#MyAppVersion}
SetupIconFile=..\src\SyncGlass.Wpf\Assets\AppIcon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
Source: "..\dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
