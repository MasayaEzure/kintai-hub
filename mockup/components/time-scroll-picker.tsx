"use client"

import * as React from "react"
import { ChevronDown, ChevronUp } from "lucide-react"

import { cn } from "@/lib/utils"

const ITEM_HEIGHT = 36
const VISIBLE_ROWS = 5
const PAD = Math.floor(VISIBLE_ROWS / 2) * ITEM_HEIGHT

export type TimeValue = {
  hour: number
  minute: number
}

function pad2(n: number) {
  return n.toString().padStart(2, "0")
}

function ScrollColumn({
  values,
  index,
  onSelect,
  ariaLabel,
  disabled,
}: {
  values: string[]
  index: number
  onSelect: (index: number) => void
  ariaLabel: string
  disabled?: boolean
}) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const scrollTimeout = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const isSettling = React.useRef(false)

  const scrollToIndex = React.useCallback((i: number, smooth: boolean) => {
    const el = containerRef.current
    if (!el) return
    isSettling.current = true
    el.scrollTo({ top: i * ITEM_HEIGHT, behavior: smooth ? "smooth" : "instant" })
    window.setTimeout(
      () => {
        isSettling.current = false
      },
      smooth ? 350 : 0
    )
  }, [])

  React.useEffect(() => {
    scrollToIndex(index, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    if (isSettling.current) return
    scrollToIndex(index, true)
  }, [index, scrollToIndex])

  const handleScroll = React.useCallback(() => {
    if (scrollTimeout.current) clearTimeout(scrollTimeout.current)
    scrollTimeout.current = setTimeout(() => {
      const el = containerRef.current
      if (!el) return
      const nextIndex = Math.min(
        values.length - 1,
        Math.max(0, Math.round(el.scrollTop / ITEM_HEIGHT))
      )
      if (nextIndex !== index) {
        onSelect(nextIndex)
      } else {
        scrollToIndex(nextIndex, true)
      }
    }, 120)
  }, [index, onSelect, scrollToIndex, values.length])

  const step = (delta: number) => {
    const next = Math.min(values.length - 1, Math.max(0, index + delta))
    onSelect(next)
    scrollToIndex(next, true)
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={disabled}
        aria-label={`${ariaLabel}を1つ戻す`}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronUp className="size-4" />
      </button>
      <div
        className="relative"
        style={{ height: ITEM_HEIGHT * VISIBLE_ROWS, width: 64 }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 rounded-md bg-accent/15 ring-1 ring-accent/40"
          style={{ top: PAD, height: ITEM_HEIGHT }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-9 bg-gradient-to-b from-card to-transparent"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-9 bg-gradient-to-t from-card to-transparent"
        />
        <div
          ref={containerRef}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={disabled ? -1 : 0}
          onScroll={disabled ? undefined : handleScroll}
          onKeyDown={(e) => {
            if (disabled) return
            if (e.key === "ArrowUp") {
              e.preventDefault()
              step(-1)
            } else if (e.key === "ArrowDown") {
              e.preventDefault()
              step(1)
            }
          }}
          className={cn(
            "h-full snap-y snap-mandatory overflow-y-auto overscroll-contain scroll-smooth outline-none",
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            disabled && "pointer-events-none opacity-40"
          )}
          style={{ paddingTop: PAD, paddingBottom: PAD }}
        >
          {values.map((v, i) => (
            <div
              key={v}
              role="option"
              aria-selected={i === index}
              className={cn(
                "flex snap-center items-center justify-center font-mono text-lg tabular-nums transition-colors",
                i === index ? "font-semibold text-foreground" : "text-muted-foreground/70"
              )}
              style={{ height: ITEM_HEIGHT }}
              onClick={() => {
                if (disabled) return
                onSelect(i)
                scrollToIndex(i, true)
              }}
            >
              {v}
            </div>
          ))}
        </div>
      </div>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={disabled}
        aria-label={`${ariaLabel}を1つ進める`}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronDown className="size-4" />
      </button>
    </div>
  )
}

const HOURS = Array.from({ length: 24 }, (_, i) => pad2(i))
const MINUTES = Array.from({ length: 12 }, (_, i) => pad2(i * 5))

export function TimeScrollPicker({
  value,
  onChange,
  disabled,
  className,
}: {
  value: TimeValue | null
  onChange: (value: TimeValue) => void
  disabled?: boolean
  className?: string
}) {
  const hourIndex = value ? value.hour : 0
  const minuteIndex = value ? Math.round(value.minute / 5) : 0

  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2 rounded-lg border border-border bg-card p-3",
        className
      )}
    >
      <div className="flex flex-col items-center gap-1">
        <ScrollColumn
          values={HOURS}
          index={hourIndex}
          disabled={disabled}
          ariaLabel="時"
          onSelect={(i) =>
            onChange({ hour: i, minute: value ? value.minute : minuteIndex * 5 })
          }
        />
        <span className="text-xs text-muted-foreground">時</span>
      </div>
      <span className="pb-6 font-mono text-lg text-muted-foreground">:</span>
      <div className="flex flex-col items-center gap-1">
        <ScrollColumn
          values={MINUTES}
          index={minuteIndex}
          disabled={disabled}
          ariaLabel="分"
          onSelect={(i) => onChange({ hour: value ? value.hour : hourIndex, minute: i * 5 })}
        />
        <span className="text-xs text-muted-foreground">分</span>
      </div>
    </div>
  )
}
