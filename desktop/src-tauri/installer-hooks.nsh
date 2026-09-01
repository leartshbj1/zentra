; Migration de marque Elyko -> Zentra pour l’installateur Windows currentUser.
; Le chemin historique est accepté uniquement s’il correspond exactement au
; dossier produit par les versions Elyko distribuées. Le profil métier reste
; séparé sous le BUNDLEID ch.helvichantier.desktop et n’est jamais supprimé ici.

Var ZentraLegacyInstall
Var ZentraLegacyDesktopShortcut
Var ZentraLegacyStartShortcut

!macro NSIS_HOOK_PREINSTALL
  StrCpy $ZentraLegacyInstall 0
  StrCpy $ZentraLegacyDesktopShortcut 0
  StrCpy $ZentraLegacyStartShortcut 0

  ReadRegStr $R8 HKCU "Software\Elyko\Elyko" ""
  ${If} $R8 == "$LOCALAPPDATA\Elyko"
  ${AndIf} ${FileExists} "$R8\Elyko.exe"
    !insertmacro CheckIfAppIsRunning "Elyko.exe" "Zentra (ancienne version)"
    StrCpy $ZentraLegacyInstall 1
    ${If} ${FileExists} "$DESKTOP\Elyko.lnk"
      StrCpy $ZentraLegacyDesktopShortcut 1
    ${EndIf}
    ${If} ${FileExists} "$SMPROGRAMS\Elyko.lnk"
      StrCpy $ZentraLegacyStartShortcut 1
    ${EndIf}

    ; SetOutPath a déjà été appelé par le template avant ce hook. Il faut donc
    ; le réappliquer après avoir sélectionné le dossier de migration.
    StrCpy $INSTDIR "$R8"
    SetOutPath "$INSTDIR"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $ZentraLegacyInstall == 1
    ; Le nouveau binaire et le nouvel uninstaller sont déjà écrits dans le
    ; même dossier. On retire seulement les artefacts de marque historiques.
    Delete "$INSTDIR\Elyko.exe"

    ${If} ${FileExists} "$SMPROGRAMS\Elyko.lnk"
      !insertmacro UnpinShortcut "$SMPROGRAMS\Elyko.lnk"
      Delete "$SMPROGRAMS\Elyko.lnk"
    ${EndIf}
    ${If} ${FileExists} "$DESKTOP\Elyko.lnk"
      !insertmacro UnpinShortcut "$DESKTOP\Elyko.lnk"
      Delete "$DESKTOP\Elyko.lnk"
    ${EndIf}

    ${If} $ZentraLegacyStartShortcut == 1
      CreateShortcut "$SMPROGRAMS\Zentra.lnk" "$INSTDIR\Zentra.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\Zentra.lnk"
    ${EndIf}
    ${If} $ZentraLegacyDesktopShortcut == 1
      CreateShortcut "$DESKTOP\Zentra.lnk" "$INSTDIR\Zentra.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\Zentra.lnk"
    ${EndIf}

    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Elyko"
    DeleteRegKey HKCU "Software\Elyko"
  ${EndIf}
!macroend
