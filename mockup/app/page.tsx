import { WorkReportSection } from "@/components/work-report-section"
import { LeaveRequestSection } from "@/components/leave-request-section"

export default function Page() {
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
        <header className="flex flex-col gap-1">
          <p className="text-sm font-medium text-primary">勤怠報告</p>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground text-balance">
            作業報告・休暇申請
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            作業を行った日時の報告と、休暇・遅参・早帰りなどの申請をこちらから行えます。
          </p>
        </header>

        <WorkReportSection />
        <LeaveRequestSection />
      </div>
    </main>
  )
}
