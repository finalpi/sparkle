import BasePage from '@renderer/components/base/base-page'
import RuleItem from '@renderer/components/rules/rule-item'
import CustomRulesModal from '@renderer/components/rules/custom-rules-modal'
import { Virtuoso } from 'react-virtuoso'
import { useMemo, useState } from 'react'
import { Button, Divider, Input } from '@heroui/react'
import { useRules } from '@renderer/hooks/use-rules'
import { includesIgnoreCase } from '@renderer/utils/includes'
import { MdSettings } from 'react-icons/md'

const Rules: React.FC = () => {
  const { rules, mutate } = useRules()
  const [filter, setFilter] = useState('')
  const [isModalOpen, setIsModalOpen] = useState(false)

  const filteredRules = useMemo(() => {
    if (!rules) return []
    if (filter === '') return rules.rules
    return rules.rules.filter((rule) => {
      return (
        includesIgnoreCase(rule.payload, filter) ||
        includesIgnoreCase(rule.type, filter) ||
        includesIgnoreCase(rule.proxy, filter)
      )
    })
  }, [rules, filter])

  return (
    <BasePage
      title="分流规则"
      header={
        <Button
          isIconOnly
          size="sm"
          variant="light"
          className="app-nodrag"
          title="自定义规则"
          onPress={() => setIsModalOpen(true)}
        >
          <MdSettings className="text-lg" />
        </Button>
      }
    >
      <div className="sticky top-0 z-40">
        <div className="flex p-2 gap-2">
          <Input
            size="sm"
            value={filter}
            placeholder="筛选过滤"
            isClearable
            onValueChange={setFilter}
            className="flex-1"
          />
          <Button
            size="sm"
            color="primary"
            variant="flat"
            startContent={<MdSettings />}
            onPress={() => setIsModalOpen(true)}
          >
            自定义规则
          </Button>
        </div>
        <Divider />
      </div>
      <div className="h-[calc(100vh-100px)] mt-px">
        <Virtuoso
          data={filteredRules}
          itemContent={(i, rule) => (
            <RuleItem
              index={i}
              type={rule.type}
              payload={rule.payload}
              proxy={rule.proxy}
              size={rule.size}
            />
          )}
        />
      </div>

      <CustomRulesModal 
        isOpen={isModalOpen} 
        onClose={() => setIsModalOpen(false)}
        onSuccess={() => mutate()}
      />
    </BasePage>
  )
}

export default Rules
