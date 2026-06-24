import { lazy, Suspense } from "react";
import { Box } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

const PumpSetupViewport = lazy(() =>
  import("@/components/pump-setup-viewport").then((module) => ({
    default: module.PumpSetupViewport,
  })),
);

export function PumpSetupPanel() {
  return (
    <Card className="glass-panel h-full min-h-0 min-w-0 overflow-hidden border-border/70">
      <CardContent className="flex h-full min-h-0 min-w-0 flex-col gap-4 p-5">
        <div className="flex min-w-0 items-center gap-2">
          <Box className="h-4 w-4 shrink-0 text-sky-600" />
          <div className="min-w-0">
            <div className="truncate text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              3D Setup
            </div>
            <h2 className="mt-1 truncate text-xl font-semibold text-foreground">
              Physical Experiment View
            </h2>
          </div>
        </div>

        <Suspense
          fallback={
            <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center rounded-lg border border-border/70 bg-slate-50 text-sm font-medium text-muted-foreground">
              Loading 3D setup
            </div>
          }
        >
          <PumpSetupViewport className="min-h-0 min-w-0 flex-1" />
        </Suspense>
      </CardContent>
    </Card>
  );
}
