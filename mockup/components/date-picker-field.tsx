"use client"

import * as React from "react"
import { CalendarDays } from "lucide-react"
import { ja } from "react-day-picker/locale"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"]

function formatJa(date: Date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日（${WEEKDAY_JA[date.getDay()]}）`
}

export function DatePickerField({
  value,
  onChange,
  disabled,
  placeholder = "日付を選択",
  className,
}: {
  value: Date | undefined
  onChange: (date: Date | undefined) => void
  disabled?: boolean
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="outline" />}
        disabled={disabled}
        className={cn(
          "w-full justify-start gap-2 font-normal",
          !value && "text-muted-foreground",
          className
        )}
      >
        <CalendarDays className="size-4" data-icon="inline-start" />
        {value ? formatJa(value) : placeholder}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          onSelect={(date) => {
            onChange(date)
            setOpen(false)
          }}
          locale={ja}
          className="rounded-lg"
        />
      </PopoverContent>
    </Popover>
  )
}
