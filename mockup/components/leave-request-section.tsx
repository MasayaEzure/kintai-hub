"use client"

import * as React from "react"
import { CalendarClock } from "lucide-react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DatePickerField } from "@/components/date-picker-field"
import { TimeScrollPicker, type TimeValue } from "@/components/time-scroll-picker"

const LEAVE_TYPES = [
  { value: "leave", label: "休暇" },
  { value: "late", label: "遅参" },
  { value: "early-leave", label: "早帰り" },
  { value: "cancel", label: "申請取り消し" },
] as const

type LeaveType = (typeof LEAVE_TYPES)[number]["value"]

const TIME_REQUIRED_TYPES: LeaveType[] = ["late", "early-leave"]

export function LeaveRequestSection() {
  const [type, setType] = React.useState<LeaveType | "">("")
  const [date, setDate] = React.useState<Date | undefined>(undefined)
  const [time, setTime] = React.useState<TimeValue | null>(null)
  const [submitted, setSubmitted] = React.useState<string | null>(null)

  const timeRequired = type ? TIME_REQUIRED_TYPES.includes(type) : false

  const isValid = Boolean(type && date && (!timeRequired || time))

  const typeLabel = LEAVE_TYPES.find((t) => t.value === type)?.label

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <CalendarClock className="size-4.5" />
          </div>
          <div>
            <CardTitle>休暇申請</CardTitle>
            <CardDescription>休暇・遅参・早帰りなどを申請します</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="leave-type">種別</FieldLabel>
            <Select
              value={type}
              onValueChange={(value) => {
                setType(value as LeaveType)
                if (!TIME_REQUIRED_TYPES.includes(value as LeaveType)) {
                  setTime(null)
                }
              }}
            >
              <SelectTrigger id="leave-type" className="w-full">
                <SelectValue placeholder="種別を選択" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {LEAVE_TYPES.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="leave-date">対象日</FieldLabel>
            <DatePickerField
              value={date}
              onChange={setDate}
              placeholder="対象日を選択"
            />
          </Field>

          <Field>
            <FieldLabel>
              時刻
              {!timeRequired && (
                <span className="text-xs font-normal text-muted-foreground">
                  （「遅参」「早帰り」選択時のみ必須）
                </span>
              )}
            </FieldLabel>
            <TimeScrollPicker
              value={time}
              onChange={setTime}
              disabled={!timeRequired}
            />
            {!timeRequired && (
              <FieldDescription>
                現在の種別では時刻の入力は不要です。
              </FieldDescription>
            )}
          </Field>

          <Field orientation="responsive" className="items-center justify-between pt-1">
            <p className="text-sm text-muted-foreground">
              {submitted
                ? `登録済み：${submitted}`
                : "種別と日時を入力すると登録できます"}
            </p>
            <Button
              type="button"
              disabled={!isValid}
              onClick={() => {
                if (!date || !type) return
                const timeStr = time
                  ? ` ${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`
                  : ""
                setSubmitted(
                  `${typeLabel} ${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}${timeStr}`
                )
              }}
            >
              登録する
            </Button>
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  )
}
