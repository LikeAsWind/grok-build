import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { autoApproveStore } from '../../../store'
import type { AlwaysAllowMode } from '../../../store/autoApproveStore'
import { themeStore, type ToolCardStyle } from '../../../store/themeStore'
import { Toggle, SegmentedControl, SettingRow, SettingField, SettingsSection } from './SettingsUI'

export function AgentSettings() {
  const { t } = useTranslation(['settings'])
  const [alwaysAllowMode, setAlwaysAllowMode] = useState<AlwaysAllowMode>(autoApproveStore.alwaysAllowMode)
  const [approvePendingOnFullAuto, setApprovePendingOnFullAuto] = useState(autoApproveStore.approvePendingOnFullAuto)
  const [descriptiveToolSteps, setDescriptiveToolSteps] = useState(themeStore.descriptiveToolSteps)
  const [inlineToolRequests, setInlineToolRequests] = useState(themeStore.inlineToolRequests)
  const [toolCardStyle, setToolCardStyle] = useState(themeStore.toolCardStyle)
  const [immersiveMode, setImmersiveMode] = useState(themeStore.immersiveMode)
  const [compactInlinePermission, setCompactInlinePermission] = useState(themeStore.compactInlinePermission)
  const [processCollapseEnabled, setProcessCollapseEnabled] = useState(themeStore.processCollapseEnabled)

  const handleAlwaysAllowModeChange = (mode: AlwaysAllowMode) => {
    const hasFrontendRules = autoApproveStore.getDebugInfo().sessions.some(session => session.rules.length > 0)
    if (mode === 'backend' && hasFrontendRules && !window.confirm(t('agent.clearFrontendRulesConfirm'))) return false
    setAlwaysAllowMode(mode)
    autoApproveStore.setAlwaysAllowMode(mode)
    if (mode === 'backend') autoApproveStore.clearAllRules()
    return true
  }

  const handleImmersiveModeToggle = () => {
    const next = !immersiveMode
    setImmersiveMode(next)
    themeStore.setImmersiveMode(next)
    setInlineToolRequests(next)
    setDescriptiveToolSteps(next)
    setCompactInlinePermission(next)
    // themeStore.setImmersiveMode 内部会把 toolCardStyle 强制设为 compact/classic，
    // 这里同步本地 state，否则分段控件要等设置面板重新挂载才会显示新值
    setToolCardStyle(next ? 'compact' : 'classic')
  }

  const toggleApprovePending = () => {
    const next = !approvePendingOnFullAuto
    setApprovePendingOnFullAuto(next)
    autoApproveStore.setApprovePendingOnFullAuto(next)
  }

  const toggleInlineToolRequests = () => {
    const next = !inlineToolRequests
    setInlineToolRequests(next)
    themeStore.setInlineToolRequests(next)
  }

  const toggleDescriptiveToolSteps = () => {
    const next = !descriptiveToolSteps
    setDescriptiveToolSteps(next)
    themeStore.setDescriptiveToolSteps(next)
  }

  const toggleProcessCollapse = () => {
    const next = !processCollapseEnabled
    setProcessCollapseEnabled(next)
    themeStore.setProcessCollapseEnabled(next)
  }

  const toggleCompactInlinePermission = () => {
    const next = !compactInlinePermission
    setCompactInlinePermission(next)
    themeStore.setCompactInlinePermission(next)
  }

  return (
    <div>
      <SettingsSection title={t('agent.behavior')} description={t('agent.behaviorDesc')}>
        <SettingField label={t('chat.alwaysAllowMode')} description={t('chat.alwaysAllowModeDesc')}>
          <div className="w-full max-w-[280px]">
            <SegmentedControl
              value={alwaysAllowMode}
              options={[
                { value: 'backend', label: t('chat.alwaysAllowBackend') },
                { value: 'frontend', label: t('chat.alwaysAllowFrontend') },
              ]}
              onChange={v => handleAlwaysAllowModeChange(v as AlwaysAllowMode)}
            />
          </div>
        </SettingField>

        <SettingRow
          label={t('chat.approvePendingOnFullAuto')}
          description={t('chat.approvePendingOnFullAutoDesc')}
          onClick={toggleApprovePending}
        >
          <Toggle enabled={approvePendingOnFullAuto} onChange={toggleApprovePending} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('agent.toolInteraction')} description={t('agent.toolInteractionDesc')}>
        <SettingRow
          label={t('chat.immersiveMode')}
          description={t('chat.immersiveModeDesc')}
          onClick={handleImmersiveModeToggle}
        >
          <Toggle enabled={immersiveMode} onChange={handleImmersiveModeToggle} />
        </SettingRow>

        <SettingRow
          label={t('chat.inlineToolRequests')}
          description={t('chat.inlineToolRequestsDesc')}
          onClick={toggleInlineToolRequests}
        >
          <Toggle enabled={inlineToolRequests} onChange={toggleInlineToolRequests} />
        </SettingRow>

        <SettingRow
          label={t('chat.descriptiveToolSteps')}
          description={t('chat.descriptiveToolStepsDesc')}
          onClick={toggleDescriptiveToolSteps}
        >
          <Toggle enabled={descriptiveToolSteps} onChange={toggleDescriptiveToolSteps} />
        </SettingRow>

        <SettingRow
          label={t('chat.processCollapse')}
          description={t('chat.processCollapseDesc')}
          onClick={toggleProcessCollapse}
        >
          <Toggle enabled={processCollapseEnabled} onChange={toggleProcessCollapse} />
        </SettingRow>

        <SettingRow
          label={t('chat.compactInlinePermission')}
          description={t('chat.compactInlinePermissionDesc')}
          onClick={toggleCompactInlinePermission}
        >
          <Toggle enabled={compactInlinePermission} onChange={toggleCompactInlinePermission} />
        </SettingRow>

        <SettingField label={t('chat.toolCardStyle')} description={t('chat.toolCardStyleDesc')}>
          <div className="w-full max-w-[280px]">
            <SegmentedControl
              value={toolCardStyle}
              options={[
                { value: 'classic', label: t('chat.toolCardClassic') },
                { value: 'compact', label: t('chat.toolCardCompact') },
              ]}
              onChange={v => {
                setToolCardStyle(v as ToolCardStyle)
                themeStore.setToolCardStyle(v as ToolCardStyle)
              }}
            />
          </div>
        </SettingField>
      </SettingsSection>
    </div>
  )
}
