; DevBridge Windows Installer — Inno Setup 6 script
; Requires: Inno Setup 6.x  (https://jrsoftware.org/isinfo.php)
;
; Pre-requisite: run  node scripts/release.mjs  to build the portable distribution first.
;
; Build (local):
;   iscc installer\devbridge.iss
;
; Build (specific version):
;   iscc /DAppVersion=0.1.0-beta.10 installer\devbridge.iss
;
; Output: release\DevBridge-Setup-{version}-win-x64.exe

#define AppName      "DevBridge"
#ifndef AppVersion
  #define AppVersion "0.1.0-dev"
#endif
#define AppPublisher "DevBridge Team"
#define AppURL       "https://github.com/tangjianfang/DevBridge"
#define AppService   "DevBridgeGateway"

[Setup]
AppId={{7B3E2C5A-9F1D-4E8B-A2C6-3D7F0E1B5A94}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
AllowNoIcons=yes
LicenseFile=..\LICENSE
OutputDir=..\release
OutputBaseFilename=DevBridge-Setup-{#AppVersion}-win-x64
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
UninstallDisplayIcon={app}\node.exe
CloseApplications=yes
RestartApplications=no
VersionInfoVersion=0.1.0.1
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Installer

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon";   Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "startupicon";   Description: "Start DevBridge on Windows startup"; GroupDescription: "Startup:"; Flags: unchecked
Name: "winsvc";        Description: "Install as Windows Service (runs without login)"; GroupDescription: "Service:"; Flags: unchecked; Check: IsAdmin

[Files]
; Node.js runtime (copied from portable distribution)
Source: "..\release\devbridge-win-x64\node.exe";   DestDir: "{app}"; Flags: ignoreversion

; Server bundle
Source: "..\release\devbridge-win-x64\server.cjs"; DestDir: "{app}"; Flags: ignoreversion

; Frontend static assets
Source: "..\release\devbridge-win-x64\public\*";   DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs

; Launcher scripts
Source: "..\release\devbridge-win-x64\start.bat";  DestDir: "{app}"; Flags: ignoreversion
Source: "..\release\devbridge-win-x64\start.ps1";  DestDir: "{app}"; Flags: ignoreversion

; Default configuration template
Source: "assets\devbridge.default.json"; DestDir: "{app}"; Flags: onlyifdoesntexist; DestName: "devbridge.json"

; Optional native bindings
Source: "..\release\devbridge-win-x64\*.node"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist external

[Icons]
Name: "{group}\{#AppName}";                        Filename: "{app}\start.bat"
Name: "{group}\{cm:UninstallProgram,{#AppName}}";  Filename: "{uninstallexe}"
Name: "{commondesktop}\{#AppName}";                Filename: "{app}\start.bat"; Tasks: desktopicon

[Registry]
; Startup registry entry (user-level)
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#AppName}"; ValueData: "cmd /c ""{app}\start.bat"""; Tasks: startupicon
; App metadata
Root: HKLM; Subkey: "Software\{#AppName}"; ValueType: string; ValueName: "InstallDir"; ValueData: "{app}"
Root: HKLM; Subkey: "Software\{#AppName}"; ValueType: string; ValueName: "Version";    ValueData: "{#AppVersion}"

[Run]
; Launch after install
Filename: "{app}\start.bat"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent; Check: not IsTaskSelected('winsvc')
; Install Windows service
Filename: "{sys}\sc.exe"; Parameters: "create ""{#AppService}"" binPath= ""{app}\node.exe"" start= auto DisplayName= ""{#AppName} Gateway"""; Flags: runhidden; Tasks: winsvc
Filename: "{sys}\sc.exe"; Parameters: "description ""{#AppService}"" ""DevBridge universal hardware interface gateway"""; Flags: runhidden; Tasks: winsvc
Filename: "{sys}\sc.exe"; Parameters: "start ""{#AppService}"""; Flags: runhidden; Tasks: winsvc

[UninstallRun]
Filename: "{sys}\sc.exe"; Parameters: "stop ""{#AppService}""";   Flags: runhidden; RunOnceId: "StopSvc"
Filename: "{sys}\sc.exe"; Parameters: "delete ""{#AppService}"""; Flags: runhidden; RunOnceId: "DelSvc"

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_LOCAL_MACHINE,
    'SYSTEM\CurrentControlSet\Control\Session Manager\Environment',
    'Path', OrigPath)
  then begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Uppercase(Param) + ';', ';' + UpperCase(OrigPath) + ';') = 0;
end;
