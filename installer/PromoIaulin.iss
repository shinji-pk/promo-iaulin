#define AppName "Promo Iaulin"
#define AppVersion "2.1.0"
#define AppPublisher "Promo Iaulin"

[Setup]
AppId={{CD1FC694-8E3D-44CB-B14C-B40183A6FE9A}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\Promo Iaulin
DefaultGroupName={#AppName}
PrivilegesRequired=lowest
UninstallDisplayIcon={app}\PromoIaulin.exe
DisableProgramGroupPage=yes
AllowNoIcons=yes
UsePreviousAppDir=yes
OutputDir=..\release
OutputBaseFilename=Promo-Iaulin-Setup
SetupIconFile=..\build-artifacts\iaulin.ico
WizardImageFile=..\build-artifacts\wizard.bmp
WizardSmallImageFile=..\build-artifacts\wizard-small.bmp
WizardStyle=modern
Compression=lzma2
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
MinVersion=10.0
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ShowLanguageDialog=no
AppCopyright=Promo Iaulin - Todos os direitos reservados
VersionInfoDescription=Instalador oficial do Promo Iaulin
VersionInfoProductName=Promo Iaulin
VersionInfoCompany=Promo Iaulin
VersionInfoVersion=2.1.0.0

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na area de trabalho"; GroupDescription: "Atalhos:"; Flags: checkedonce

[Files]
Source: "..\build-artifacts\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Promo Iaulin"; Filename: "{app}\PromoIaulin.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Promo Iaulin"; Filename: "{app}\PromoIaulin.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\PromoIaulin.exe"; Description: "Abrir Promo Iaulin agora"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Nunca excluir automaticamente %LOCALAPPDATA%\Promo Iaulin.
; Esta pasta guarda o banco de dados, credenciais criptografadas e a sessao do WhatsApp.
