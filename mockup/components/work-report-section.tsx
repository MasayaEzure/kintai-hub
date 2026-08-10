"use client"

import * as React from "react"
import { ClipboardCheck } from "lucide-react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { DatePickerField } from "@/components/date-picker-field"
import { TimeScrollPicker, type TimeValue } from "@/components/time-scroll-picker"

export function WorkReportSection() {
  const [date, setDate] = React.useState<Date | undefined>(undefined)
  const [time, setTime] = React.useState<TimeValue | null>(null)
  const [submitted, setSubmitted] = React.useState<string | null>(null)

  const isValid = Boolean(date && time)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ClipboardCheck className="size-4.5" />
          </div>
          <div>
            <CardTitle>作業報告</CardTitle>
            <CardDescription>作業を行った日時を報告します</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="work-report-date">作業日</FieldLabel>
            <DatePickerField
              value={date}
              onChange={setDate}
              placeholder="作業日を選択"
            />
          </Field>

          <Field>
            <FieldLabel>作業時刻</FieldLabel>
            <TimeScrollPicker value={time} onChange={setTime} />
          </Field>

          <Field orientation="responsive" className="items-center justify-between pt-1">
            <p className="text-sm text-muted-foreground">
              {submitted
                ? `登録済み：${submitted}`
                : "日時を入力すると登録できます"}
            </p>
            <Button
              type="button"
              disabled={!isValid}
              onClick={() => {
                if (!date || !time) return
                setSubmitted(
                  `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`
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
