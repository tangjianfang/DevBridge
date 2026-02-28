; DevBridge Windows Installer — Inno Setup 6 script
; Requires: Inno Setup 6.x  (https://jrsoftware.org/isinfo.php)
;
; Build:
;   iscc installer\devbridge.iss
;
; Output: installer\Output\DevBridge-Setup-0.1.0-beta.1.exe

#define AppName      "DevBridge"
#define AppVersion   "0.1.0-beta.1"
#define AppPublisher "DevBridge Team"
#define AppURL       "https://github.com/your-org/DevBridge"
#define AppExeName   "devbridge.exe"
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
OutputDir=Output
OutputBaseFilename=DevBridge-Setup-{#AppVersion}
SetupIconFile=assets\icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
UninstallDisplayIcon={app}\{#AppExeName}
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
; Main executable (pkg bundle — includes Node.js runtime + server code)
Source: "..\release\{#AppExeName}";        DestDir: "{app}";              Flags: ignoreversion

; Frontend static assets
Source: "..\dist\public\*";                DestDir: "{app}\public";        Flags: ignoreversion recursesubdirs createallsubdirs; Check: DirExists('..\dist\public')

; Optional native bindings (only if they exist)
Source: "..\release\*.node";               DestDir: "{app}";               Flags: ignoreversion skipifsourcedoesntexist external

; Default configuration template
Source: "assets\devbridge.default.json";   DestDir: "{app}";               Flags: onlyifdoesntexist; DestName: "devbridge.json"

[Icons]
Name: "{group}\{#AppName}";               Filename: "{app}\{#AppExeName}"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{commondesktop}\{#AppName}";       Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Registry]
; Add to PATH (machine-level)
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Check: NeedsAddPath(ExpandConstant('{app}'))
; Startup registry entry (user-level)
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#AppName}"; ValueData: """{app}\{#AppExeName}"""; Tasks: startupicon
; App metadata
Root: HKLM; Subkey: "Software\{#AppName}"; ValueType: string; ValueName: "InstallDir";  ValueData: "{app}"
Root: HKLM; Subkey: "Software\{#AppName}"; ValueType: string; ValueName: "Version";     ValueData: "{#AppVersion}"

[Run]
; Launch after install
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent; Check: not IsTaskSelected('winsvc')
; Install Windows service
Filename: "{sys}\sc.exe"; Parameters: "create ""{#AppService}"" binPath= """"""{app}\{#AppExeName}"""""" start= auto DisplayName= ""{#AppName} Gateway"""; Flags: runhidden; Tasks: winsvc
Filename: "{sys}\sc.exe"; Parameters: "description ""{#AppService}"" ""DevBridge universal hardware interface gateway"""; Flags: runhidden; Tasks: winsvc
Filename: "{sys}\sc.exe"; Parameters: "start ""{#AppService}"""; Flags: runhidden; Tasks: winsvc

[UninstallRun]
Filename: "{sys}\sc.exe"; Parameters: "stop ""{#AppService}""";   Flags: runhidden; RunOnceId: "StopSvc"
Filename: "{sys}\sc.exe"; Parameters: "delete ""{#AppService}"""; Flags: runhidden; RunOnceId: "DelSvc"

[Code]
// Check whether the app directory is already in the PATH
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
