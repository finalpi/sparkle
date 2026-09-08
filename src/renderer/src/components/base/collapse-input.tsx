import React, { useEffect, useRef, useState } from 'react'
import { Input, InputProps } from '@heroui/react'
import { FaSearch } from 'react-icons/fa'

type CollapseInputProps = InputProps

const CollapseInput: React.FC<CollapseInputProps> = (props) => {
  const { value, onChange, onValueChange, ...inputProps } = props
  const inputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const [internalValue, setInternalValue] = useState<string>((value as string) ?? '')

  useEffect(() => {
    if (!composingRef.current) {
      setInternalValue((value as string) ?? '')
    }
  }, [value])

  return (
    <div className="flex">
      <Input
        size="sm"
        ref={inputRef}
        {...inputProps}
        value={internalValue}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={(e) => {
          composingRef.current = false
          const val = (e.target as HTMLInputElement).value
          setInternalValue(val)
          onValueChange?.(val)
          onChange?.(e as unknown as React.ChangeEvent<HTMLInputElement>)
        }}
        onChange={(e) => {
          const val = e.target.value
          setInternalValue(val)
          if (!composingRef.current) {
            onChange?.(e)
            onValueChange?.(val)
          }
        }}
        style={{ paddingInlineEnd: 0 }}
        classNames={{
          inputWrapper: 'cursor-pointer bg-transparent p-0 data-[hover=true]:bg-content2',
          input: `w-0 focus:w-[150px] focus:ml-2 ${internalValue ? 'w-[150px] ml-2' : ''} transition-all duration-200`
        }}
        endContent={
          <div
            className="cursor-pointer p-2 text-lg text-foreground-500"
            onClick={(e) => {
              e.stopPropagation()
              if (inputRef.current?.offsetWidth != 0) {
                inputRef.current?.blur()
              } else {
                inputRef.current?.focus()
              }
            }}
          >
            <FaSearch />
          </div>
        }
        onClick={(e) => {
          e.stopPropagation()
          inputRef.current?.focus()
        }}
      />
    </div>
  )
}

export default CollapseInput
