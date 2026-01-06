import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Input,
  Select,
  SelectItem,
  Divider,
  Chip,
  Tabs,
  Tab
} from '@heroui/react'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { restartCore, mihomoGroups } from '@renderer/utils/ipc'
import { useState, useEffect, useMemo } from 'react'
import { MdAdd, MdDelete, MdDragIndicator } from 'react-icons/md'
import { IoMdInformationCircle } from 'react-icons/io'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

interface Props {
  isOpen: boolean
  onClose: () => void
  onSuccess?: () => void
}

/**
 * 规则类型定义
 */
const RULE_TYPES = [
  { key: 'DOMAIN', label: 'DOMAIN', example: 'google.com' },
  { key: 'DOMAIN-SUFFIX', label: 'DOMAIN-SUFFIX', example: 'google.com' },
  { key: 'DOMAIN-KEYWORD', label: 'DOMAIN-KEYWORD', example: 'google' },
  { key: 'DOMAIN-WILDCARD', label: 'DOMAIN-WILDCARD', example: '*.google.com' },
  { key: 'DOMAIN-REGEX', label: 'DOMAIN-REGEX', example: '^abc.*com' },
  { key: 'GEOSITE', label: 'GEOSITE', example: 'youtube' },
  { key: 'IP-CIDR', label: 'IP-CIDR', example: '127.0.0.0/8' },
  { key: 'IP-SUFFIX', label: 'IP-SUFFIX', example: '8.8.8.8/24' },
  { key: 'IP-ASN', label: 'IP-ASN', example: '13335' },
  { key: 'GEOIP', label: 'GEOIP', example: 'CN' },
  { key: 'SRC-IP-CIDR', label: 'SRC-IP-CIDR', example: '192.168.1.0/24' },
  { key: 'SRC-GEOIP', label: 'SRC-GEOIP', example: 'CN' },
  { key: 'DST-PORT', label: 'DST-PORT', example: '80' },
  { key: 'SRC-PORT', label: 'SRC-PORT', example: '7777' },
  { key: 'PROCESS-NAME', label: 'PROCESS-NAME', example: 'chrome.exe' },
  { key: 'PROCESS-PATH', label: 'PROCESS-PATH', example: '/usr/bin/wget' },
  { key: 'RULE-SET', label: 'RULE-SET', example: 'providername' },
  { key: 'MATCH', label: 'MATCH', example: '' }
]

/**
 * 可拖拽的规则项组件
 */
interface RuleItemProps {
  rule: string
  index: number
  onRemove: () => void
}

const SortableRuleItem: React.FC<RuleItemProps> = ({ rule, index, onRemove }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rule + index
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 p-2 bg-background rounded border border-divider hover:border-primary transition-colors"
    >
      <div {...attributes} {...listeners} className="cursor-move">
        <MdDragIndicator className="text-lg text-default-400" />
      </div>
      <span className="text-sm font-mono flex-1 break-all">{rule}</span>
      <Button isIconOnly size="sm" color="danger" variant="light" onPress={onRemove}>
        <MdDelete className="text-lg" />
      </Button>
    </div>
  )
}

/**
 * 自定义规则管理弹窗
 * 用于管理前置规则和后置规则
 */
const CustomRulesModal: React.FC<Props> = ({ isOpen, onClose, onSuccess }) => {
  const { appConfig, patchAppConfig } = useAppConfig()
  const [prependRules, setPrependRules] = useState<string[]>([])
  const [appendRules, setAppendRules] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [groups, setGroups] = useState<ControllerMixedGroup[]>([])
  const [isSavingRef, setIsSavingRef] = useState(false) // 防止保存过程中状态被重置

  // 规则表单状态
  const [ruleType, setRuleType] = useState('DOMAIN')
  const [rulePayload, setRulePayload] = useState('')
  const [rulePolicy, setRulePolicy] = useState('DIRECT')

  /**
   * 策略选项（内置策略 + 代理组，排除 GLOBAL）
   */
  const policyOptions = useMemo(() => {
    const builtInPolicies = [
      { key: 'DIRECT', label: 'DIRECT' },
      { key: 'REJECT', label: 'REJECT' }
    ]
    
    // 过滤掉 GLOBAL 策略
    const groupPolicies = groups
      .filter((group) => group.name !== 'GLOBAL')
      .map((group) => ({
        key: group.name,
        label: group.name
      }))
    
    return [...builtInPolicies, ...groupPolicies]
  }, [groups])

  // 拖拽传感器
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8
      }
    })
  )

  // 加载代理组
  useEffect(() => {
    if (isOpen) {
      mihomoGroups()
        .then((data) => {
          setGroups(data)
          // 如果有代理组，默认选择第一个
          if (data.length > 0 && rulePolicy === 'DIRECT') {
            setRulePolicy(data[0].name)
          }
        })
        .catch(() => {
          setGroups([])
        })
    }
  }, [isOpen])

  // 从配置加载规则
  useEffect(() => {
    // 只在打开弹窗时加载，保存过程中不重置
    if (isOpen && appConfig && !isSavingRef) {
      console.log('加载配置中的规则:', appConfig.prependRules, appConfig.appendRules)
      setPrependRules(appConfig.prependRules || [])
      setAppendRules(appConfig.appendRules || [])
    }
  }, [isOpen, appConfig, isSavingRef])

  /**
   * 构建规则字符串
   */
  const buildRuleString = (): string => {
    // MATCH 类型不需要 payload
    if (ruleType === 'MATCH') {
      return `${ruleType},${rulePolicy}`
    }
    
    if (!rulePayload.trim()) {
      return ''
    }

    return `${ruleType},${rulePayload.trim()},${rulePolicy}`
  }

  /**
   * 添加前置规则
   */
  const handleAddPrepend = (): void => {
    const rule = buildRuleString()
    if (rule) {
      setPrependRules([...prependRules, rule])
      setRulePayload('')
    }
  }

  /**
   * 添加后置规则
   */
  const handleAddAppend = (): void => {
    const rule = buildRuleString()
    if (rule) {
      setAppendRules([...appendRules, rule])
      setRulePayload('')
    }
  }

  /**
   * 处理前置规则拖拽结束
   */
  const handlePrependDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = prependRules.findIndex((_, i) => active.id === prependRules[i] + i)
    const newIndex = prependRules.findIndex((_, i) => over.id === prependRules[i] + i)

    const newRules = [...prependRules]
    const [removed] = newRules.splice(oldIndex, 1)
    newRules.splice(newIndex, 0, removed)
    setPrependRules(newRules)
  }

  /**
   * 处理后置规则拖拽结束
   */
  const handleAppendDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = appendRules.findIndex((_, i) => active.id === appendRules[i] + i)
    const newIndex = appendRules.findIndex((_, i) => over.id === appendRules[i] + i)

    const newRules = [...appendRules]
    const [removed] = newRules.splice(oldIndex, 1)
    newRules.splice(newIndex, 0, removed)
    setAppendRules(newRules)
  }

  /**
   * 保存配置并重启核心
   */
  const handleSave = async (): Promise<void> => {
    try {
      setSaving(true)
      setIsSavingRef(true) // 标记正在保存，防止useEffect重置状态
      
      console.log('保存自定义规则:', { prependRules, appendRules })
      
      // 保存配置（patchAppConfig会自动触发mutateAppConfig）
      await patchAppConfig({
        prependRules,
        appendRules
      })
      
      console.log('配置已保存，准备重启核心')
      
      // 重启核心以应用规则
      await restartCore()
      
      console.log('核心已重启')
      
      // 等待一小段时间确保核心完全启动
      await new Promise(resolve => setTimeout(resolve, 500))
      
      // 通知父组件刷新规则列表
      onSuccess?.()
      
      onClose()
    } catch (error) {
      console.error('保存失败:', error)
      alert(`保存失败: ${error}`)
    } finally {
      setSaving(false)
      setIsSavingRef(false) // 清除保存标记
    }
  }

  /**
   * 取消编辑，重置所有状态到初始值
   */
  const handleCancel = (): void => {
    // 重置规则列表到配置中的原始值
    setPrependRules(appConfig?.prependRules || [])
    setAppendRules(appConfig?.appendRules || [])
    
    // 重置表单状态
    setRuleType('DOMAIN')
    setRulePayload('')
    setRulePolicy('DIRECT')
    
    // 关闭模态框
    onClose()
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="4xl"
      scrollBehavior="inside"
      classNames={{
        base: 'max-h-[90vh]'
      }}
    >
      <ModalContent>
        <ModalHeader>自定义规则管理</ModalHeader>
        <ModalBody>
          {/* 说明信息 */}
          <div className="flex items-start gap-2 p-3 bg-default-100 rounded-lg">
            <IoMdInformationCircle className="text-xl text-primary flex-shrink-0 mt-0.5" />
            <div className="text-sm text-foreground-600">
              <p className="mb-1">
                <strong>前置规则</strong>会插入到所有规则的最前面，优先级最高。
              </p>
              <p className="mb-1">
                <strong>后置规则</strong>会追加到所有规则的最后面，作为兜底规则。
              </p>
              <p className="text-xs text-foreground-500">
                拖动 <MdDragIndicator className="inline text-base" /> 图标可以调整规则顺序
              </p>
            </div>
          </div>

          <Divider className="my-4" />

          {/* 规则添加器 */}
          <Tabs aria-label="规则类型" color="primary" variant="bordered">
            {/* 前置规则 Tab */}
            <Tab
              key="prepend"
              title={
                <div className="flex items-center gap-2">
                  <span>前置规则</span>
                  <Chip size="sm" variant="flat">
                    {prependRules.length}
                  </Chip>
                </div>
              }
            >
              <div className="space-y-4 pt-4">
                {/* 添加规则表单 */}
                <div className="grid grid-cols-12 gap-2">
                  <Select
                    label="规则类型"
                    selectedKeys={[ruleType]}
                    onChange={(e) => setRuleType(e.target.value)}
                    className="col-span-3"
                    size="sm"
                  >
                    {RULE_TYPES.map((type) => (
                      <SelectItem key={type.key}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </Select>

                  <Input
                    label="规则内容"
                    placeholder={
                      RULE_TYPES.find((t) => t.key === ruleType)?.example || '请输入规则内容'
                    }
                    value={rulePayload}
                    onValueChange={setRulePayload}
                    className="col-span-5"
                    size="sm"
                    isDisabled={ruleType === 'MATCH'}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleAddPrepend()
                      }
                    }}
                  />

                  <Select
                    label="策略"
                    selectedKeys={[rulePolicy]}
                    onChange={(e) => setRulePolicy(e.target.value)}
                    className="col-span-3"
                    size="sm"
                  >
                    {policyOptions.map((policy) => (
                      <SelectItem key={policy.key}>
                        {policy.label}
                      </SelectItem>
                    ))}
                  </Select>

                  <Button
                    color="primary"
                    variant="flat"
                    onPress={handleAddPrepend}
                    className="col-span-1"
                    size="lg"
                    isDisabled={ruleType !== 'MATCH' && !rulePayload.trim()}
                  >
                    <MdAdd className="text-xl" />
                  </Button>
                </div>

                {/* 前置规则列表 */}
                {prependRules.length > 0 && (
                  <div className="space-y-2 max-h-64 overflow-y-auto p-2 bg-default-50 rounded-lg">
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handlePrependDragEnd}
                    >
                      <SortableContext
                        items={prependRules.map((rule, i) => rule + i)}
                        strategy={verticalListSortingStrategy}
                      >
                        {prependRules.map((rule, index) => (
                          <SortableRuleItem
                            key={rule + index}
                            rule={rule}
                            index={index}
                            onRemove={() =>
                              setPrependRules(prependRules.filter((_, i) => i !== index))
                            }
                          />
                        ))}
                      </SortableContext>
                    </DndContext>
                  </div>
                )}
              </div>
            </Tab>

            {/* 后置规则 Tab */}
            <Tab
              key="append"
              title={
                <div className="flex items-center gap-2">
                  <span>后置规则</span>
                  <Chip size="sm" variant="flat">
                    {appendRules.length}
                  </Chip>
                </div>
              }
            >
              <div className="space-y-4 pt-4">
                {/* 添加规则表单 */}
                <div className="grid grid-cols-12 gap-2">
                  <Select
                    label="规则类型"
                    selectedKeys={[ruleType]}
                    onChange={(e) => setRuleType(e.target.value)}
                    className="col-span-3"
                    size="sm"
                  >
                    {RULE_TYPES.map((type) => (
                      <SelectItem key={type.key}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </Select>

                  <Input
                    label="规则内容"
                    placeholder={
                      RULE_TYPES.find((t) => t.key === ruleType)?.example || '请输入规则内容'
                    }
                    value={rulePayload}
                    onValueChange={setRulePayload}
                    className="col-span-5"
                    size="sm"
                    isDisabled={ruleType === 'MATCH'}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleAddAppend()
                      }
                    }}
                  />

                  <Select
                    label="策略"
                    selectedKeys={[rulePolicy]}
                    onChange={(e) => setRulePolicy(e.target.value)}
                    className="col-span-3"
                    size="sm"
                  >
                    {policyOptions.map((policy) => (
                      <SelectItem key={policy.key}>
                        {policy.label}
                      </SelectItem>
                    ))}
                  </Select>

                  <Button
                    color="primary"
                    variant="flat"
                    onPress={handleAddAppend}
                    className="col-span-1"
                    size="lg"
                    isDisabled={ruleType !== 'MATCH' && !rulePayload.trim()}
                  >
                    <MdAdd className="text-xl" />
                  </Button>
                </div>

                {/* 后置规则列表 */}
                {appendRules.length > 0 && (
                  <div className="space-y-2 max-h-64 overflow-y-auto p-2 bg-default-50 rounded-lg">
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleAppendDragEnd}
                    >
                      <SortableContext
                        items={appendRules.map((rule, i) => rule + i)}
                        strategy={verticalListSortingStrategy}
                      >
                        {appendRules.map((rule, index) => (
                          <SortableRuleItem
                            key={rule + index}
                            rule={rule}
                            index={index}
                            onRemove={() =>
                              setAppendRules(appendRules.filter((_, i) => i !== index))
                            }
                          />
                        ))}
                      </SortableContext>
                    </DndContext>
                  </div>
                )}
              </div>
            </Tab>
          </Tabs>
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={handleCancel}>
            取消
          </Button>
          <Button color="primary" onPress={handleSave} isLoading={saving}>
            {saving ? '正在保存并重启核心...' : '保存并应用'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

export default CustomRulesModal
