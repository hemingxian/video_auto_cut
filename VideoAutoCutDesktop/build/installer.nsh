!define VACUT_DATA_ROOT_REG_KEY "Software\VideoAutoCut"
!define VACUT_DATA_ROOT_REG_VALUE "UserDataRoot"
!define VACUT_DATA_ROOT_MARKER_FILE "vacut-user-data-root.txt"
!define VACUT_DATA_ROOT_SENTINEL_FILE ".videoautocut-data-root"
!define VACUT_INSTALL_ROOT_SENTINEL_FILE ".videoautocut-install-root"
!define /ifndef INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!define /ifndef UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"

!ifndef BUILD_UNINSTALLER
!include FileFunc.nsh
!include nsDialogs.nsh
!include StrContains.nsh

Var /GLOBAL vacutDataDir
Var /GLOBAL vacutDataDirInput
Var /GLOBAL vacutInstallDirInput

Function vacutNormalizeInstallDir
  Push $0

  StrLen $0 "$INSTDIR"
  ${If} $0 > 3
    IntOp $0 $0 - 1
    StrCpy $0 "$INSTDIR" 1 $0
    ${If} $0 == "\"
      StrLen $0 "$INSTDIR"
      IntOp $0 $0 - 1
      StrCpy $INSTDIR "$INSTDIR" $0
    ${EndIf}
  ${EndIf}

  ${GetFileName} "$INSTDIR" $0
  ${If} $0 != "${APP_FILENAME}"
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}

  Pop $0
FunctionEnd

Function vacutPrepareLegacyInstall
  Push $0
  Push $1
  Push $2

  StrCpy $0 ""
  ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation

  ${If} $0 != ""
    StrCpy $1 "1"
    IfFileExists "$0\${VACUT_INSTALL_ROOT_SENTINEL_FILE}" 0 +2
      StrCpy $1 "0"

    ${GetFileName} "$0" $2
    ${If} $2 == "${APP_FILENAME}"
      StrCpy $1 "0"
    ${EndIf}

    IfFileExists "$0\Uninstall ${PRODUCT_FILENAME}.exe" 0 vacutLegacyInstallNeedsMigration
    ${If} $1 == "1"
      Goto vacutLegacyInstallNeedsMigration
    ${EndIf}
    Goto vacutLegacyInstallDone

    vacutLegacyInstallNeedsMigration:
      DetailPrint "Migrating legacy VideoAutoCut installation to a dedicated directory."
      StrCpy $INSTDIR "$0"

      DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
      !ifdef UNINSTALL_REGISTRY_KEY_2
        DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"
      !endif
      DeleteRegKey SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}"

      Call vacutNormalizeInstallDir

    vacutLegacyInstallDone:
  ${EndIf}

  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function vacutInitDataDir
  Push $0
  Push $1

  ReadEnvStr $vacutDataDir "LOCALAPPDATA"
  ${If} $vacutDataDir == ""
    StrCpy $vacutDataDir "$PROFILE\AppData\Local"
  ${EndIf}
  StrCpy $vacutDataDir "$vacutDataDir\VideoAutoCut"

  ReadRegStr $0 HKCU "${VACUT_DATA_ROOT_REG_KEY}" "${VACUT_DATA_ROOT_REG_VALUE}"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "${VACUT_DATA_ROOT_REG_KEY}" "${VACUT_DATA_ROOT_REG_VALUE}"
  ${EndIf}
  ${If} $0 != ""
    StrCpy $vacutDataDir "$0"
  ${EndIf}

  ClearErrors
  ${GetParameters} $0
  ${GetOptions} $0 "--user-data-dir" $1
  ${IfNot} ${Errors}
    ${If} $1 != ""
      StrCpy $vacutDataDir "$1"
    ${EndIf}
  ${EndIf}

  Pop $1
  Pop $0
FunctionEnd

Function vacutNormalizeDataDir
  Push $0
  Push $1

  StrLen $0 "$vacutDataDir"
  ${If} $0 > 3
    IntOp $0 $0 - 1
    StrCpy $1 "$vacutDataDir" 1 $0
    ${If} $1 == "\"
      StrCpy $vacutDataDir "$vacutDataDir" $0
    ${EndIf}
  ${EndIf}

  ${StrContains} $0 "VideoAutoCut" "$vacutDataDir"
  ${If} $0 == ""
    StrCpy $vacutDataDir "$vacutDataDir\VideoAutoCut"
  ${EndIf}

  Pop $1
  Pop $0
FunctionEnd

Function vacutBrowseInstallDir
  nsDialogs::SelectFolderDialog "选择程序安装目录" "$INSTDIR"
  Pop $0
  ${If} $0 != "error"
  ${AndIf} $0 != ""
    StrCpy $INSTDIR "$0"
    ${NSD_SetText} $vacutInstallDirInput "$INSTDIR"
  ${EndIf}
FunctionEnd

Function vacutBrowseDataDir
  nsDialogs::SelectFolderDialog "选择用户数据目录" "$vacutDataDir"
  Pop $1
  ${If} $1 != "error"
  ${AndIf} $1 != ""
    StrCpy $vacutDataDir "$1"
    Call vacutNormalizeDataDir
    ${NSD_SetText} $vacutDataDirInput "$vacutDataDir"
  ${EndIf}
FunctionEnd

Function vacutDirectoryPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == "error"
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 12u "选择安装和用户数据目录"
  Pop $0

  ${NSD_CreateLabel} 0 18u 100% 12u "程序安装位置（将自动创建 ${APP_FILENAME} 子目录）"
  Pop $0

  ${NSD_CreateText} 0 33u 78% 13u "$INSTDIR"
  Pop $vacutInstallDirInput

  ${NSD_CreateButton} 81% 32u 19% 15u "浏览..."
  Pop $0
  ${NSD_OnClick} $0 vacutBrowseInstallDir

  ${NSD_CreateLabel} 0 57u 100% 18u "用户数据目录。可以选择父目录，安装器会自动使用其中的 VideoAutoCut 子目录。"
  Pop $0

  ${NSD_CreateText} 0 78u 78% 13u "$vacutDataDir"
  Pop $vacutDataDirInput

  ${NSD_CreateButton} 81% 77u 19% 15u "浏览..."
  Pop $0
  ${NSD_OnClick} $0 vacutBrowseDataDir

  ${NSD_CreateLabel} 0 103u 100% 24u "卸载时如果选择删除用户数据，会清理用户数据目录。请不要选择磁盘根目录或其他软件正在使用的目录。"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function vacutDirectoryPageLeave
  ${NSD_GetText} $vacutInstallDirInput $INSTDIR
  ${NSD_GetText} $vacutDataDirInput $vacutDataDir

  ${If} $INSTDIR == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "请选择程序安装目录。"
    Abort
  ${EndIf}

  Call vacutNormalizeInstallDir
  ${NSD_SetText} $vacutInstallDirInput "$INSTDIR"

  ${If} $vacutDataDir == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "请选择用户数据目录。"
    Abort
  ${EndIf}

  Call vacutNormalizeDataDir
  ${NSD_SetText} $vacutDataDirInput "$vacutDataDir"

  ${GetRoot} "$INSTDIR" $0
  ${If} $0 == "$INSTDIR"
    MessageBox MB_OK|MB_ICONEXCLAMATION "不能把磁盘根目录作为程序安装目录，请选择或创建一个专用文件夹。"
    Abort
  ${EndIf}

  ${GetRoot} "$vacutDataDir" $0
  ${If} $0 == "$vacutDataDir"
    MessageBox MB_OK|MB_ICONEXCLAMATION "不能把磁盘根目录作为用户数据目录，请选择或创建一个专用文件夹。"
    Abort
  ${EndIf}

  ${If} $INSTDIR == "$vacutDataDir"
    MessageBox MB_OK|MB_ICONEXCLAMATION "程序安装目录和用户数据目录不能是同一个目录。"
    Abort
  ${EndIf}

  ClearErrors
  CreateDirectory "$INSTDIR"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "无法创建程序安装目录，请检查权限：$\r$\n$INSTDIR"
    Abort
  ${EndIf}

  ClearErrors
  CreateDirectory "$vacutDataDir"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "无法创建用户数据目录，请检查权限：$\r$\n$vacutDataDir"
    Abort
  ${EndIf}
FunctionEnd

!macro customInit
  Call vacutInitDataDir
  Call vacutPrepareLegacyInstall
  Call vacutNormalizeInstallDir
!macroend

!macro customPageAfterChangeDir
  Page custom vacutDirectoryPageCreate vacutDirectoryPageLeave
!macroend

!macro customInstall
  ${If} $vacutDataDir == ""
    Call vacutInitDataDir
  ${EndIf}

  CreateDirectory "$vacutDataDir"
  FileOpen $0 "$INSTDIR\${VACUT_INSTALL_ROOT_SENTINEL_FILE}" w
  ${IfNot} ${Errors}
    FileWrite $0 "VideoAutoCut application root"
    FileClose $0
  ${EndIf}

  ClearErrors
  FileOpen $0 "$vacutDataDir\${VACUT_DATA_ROOT_SENTINEL_FILE}" w
  ${IfNot} ${Errors}
    FileWrite $0 "VideoAutoCut user data root"
    FileClose $0
  ${EndIf}

  WriteRegStr HKCU "${VACUT_DATA_ROOT_REG_KEY}" "${VACUT_DATA_ROOT_REG_VALUE}" "$vacutDataDir"
  ${If} $installMode == "all"
    WriteRegStr HKLM "${VACUT_DATA_ROOT_REG_KEY}" "${VACUT_DATA_ROOT_REG_VALUE}" "$vacutDataDir"
  ${EndIf}

  ClearErrors
  FileOpen $0 "$INSTDIR\${VACUT_DATA_ROOT_MARKER_FILE}" w
  ${IfNot} ${Errors}
    FileWrite $0 "$vacutDataDir"
    FileClose $0
  ${EndIf}
!macroend
!endif

!macro customUnInstall
  ${IfNot} ${isUpdated}
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}

    StrCpy $3 "$LOCALAPPDATA\VideoAutoCut"
    ReadRegStr $4 HKCU "${VACUT_DATA_ROOT_REG_KEY}" "${VACUT_DATA_ROOT_REG_VALUE}"
    ${If} $4 == ""
      ReadRegStr $4 HKLM "${VACUT_DATA_ROOT_REG_KEY}" "${VACUT_DATA_ROOT_REG_VALUE}"
    ${EndIf}
    ${If} $4 == ""
    ${AndIf} ${FileExists} "$INSTDIR\${VACUT_DATA_ROOT_MARKER_FILE}"
      ClearErrors
      FileOpen $5 "$INSTDIR\${VACUT_DATA_ROOT_MARKER_FILE}" r
      ${IfNot} ${Errors}
        FileRead $5 $4
        FileClose $5
      ${EndIf}
    ${EndIf}
    ${If} $4 != ""
      StrCpy $3 "$4"
    ${EndIf}

    StrCpy $0 "0"

    ClearErrors
    ${GetParameters} $1
    ${GetOptions} $1 "--delete-app-data" $2
    ${IfNot} ${Errors}
      StrCpy $0 "1"
    ${EndIf}

    ${If} $0 != "1"
    ${AndIfNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
        "是否同时删除本机用户数据？$\r$\n$\r$\n将删除：$3$\r$\n包含软件配置、缓存、运行环境、历史任务和默认工作区。$\r$\n$\r$\n选择“否”会保留这些数据，之后重新安装仍可继续使用。" \
        IDNO +2
      StrCpy $0 "1"
    ${EndIf}

    ${If} $0 == "1"
      SetOutPath "$TEMP"

      StrCpy $6 "0"
      IfFileExists "$3\${VACUT_DATA_ROOT_SENTINEL_FILE}" 0 +2
        StrCpy $6 "1"
      ${If} $3 == "$LOCALAPPDATA\VideoAutoCut"
        StrCpy $6 "1"
      ${EndIf}

      ${If} $6 == "1"
        RMDir /r "$3"
        RMDir "$3"
      ${Else}
        ${IfNot} ${Silent}
          MessageBox MB_OK|MB_ICONEXCLAMATION "检测到用户数据目录不像 VideoAutoCut 专用目录，为避免误删，未自动删除：$3"
        ${EndIf}
      ${EndIf}
      RMDir /r "$LOCALAPPDATA\VideoAutoCut"
      RMDir "$LOCALAPPDATA\VideoAutoCut"

      ${If} $6 != "1"
        Goto vacutAppDataDeleted
      ${EndIf}

      IfFileExists "$3" vacutRetryDeleteAppData vacutAppDataDeleted

      vacutRetryDeleteAppData:
        Sleep 1200
        RMDir /r /REBOOTOK "$3"
        RMDir /REBOOTOK "$3"
        RMDir /r /REBOOTOK "$LOCALAPPDATA\VideoAutoCut"
        RMDir /REBOOTOK "$LOCALAPPDATA\VideoAutoCut"
        IfFileExists "$3" vacutAppDataDeleteFailed vacutAppDataDeleted

      vacutAppDataDeleteFailed:
        ${IfNot} ${Silent}
          MessageBox MB_OK|MB_ICONEXCLAMATION "用户数据目录未能完全删除，可能仍有文件被系统占用。$\r$\n$\r$\n请关闭相关进程后手动删除：$3"
        ${EndIf}
        Goto vacutAppDataDeleteDone

      vacutAppDataDeleted:
        Goto vacutAppDataDeleteDone

      vacutAppDataDeleteDone:
      DeleteRegValue HKCU "${VACUT_DATA_ROOT_REG_KEY}" "${VACUT_DATA_ROOT_REG_VALUE}"
      DeleteRegKey /ifempty HKCU "${VACUT_DATA_ROOT_REG_KEY}"
      ${If} $installMode == "all"
        DeleteRegValue HKLM "${VACUT_DATA_ROOT_REG_KEY}" "${VACUT_DATA_ROOT_REG_VALUE}"
        DeleteRegKey /ifempty HKLM "${VACUT_DATA_ROOT_REG_KEY}"
      ${EndIf}
    ${EndIf}

    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
