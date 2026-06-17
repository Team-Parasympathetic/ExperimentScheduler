import { useState } from "react";
import {
  Box,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  ListTree,
} from "lucide-react";
import { DeviceOverviewPanel } from "@/components/device-overview-panel";
import { PumpCalibrationPanel } from "@/components/pump-calibration-panel";
import { PumpSetupPanel } from "@/components/pump-setup-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type SidebarView = "devices" | "calibration" | "setup";

interface SchedulerSidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

const SIDEBAR_VIEWS: Array<{
  id: SidebarView;
  label: string;
  eyebrow: string;
  Icon: typeof ListTree;
}> = [
  {
    id: "devices",
    label: "Device Overview",
    eyebrow: "Devices",
    Icon: ListTree,
  },
  {
    id: "calibration",
    label: "Pump Calibration",
    eyebrow: "Calibration",
    Icon: FlaskConical,
  },
  {
    id: "setup",
    label: "3D Setup",
    eyebrow: "Setup",
    Icon: Box,
  },
];

export function SchedulerSidebar({
  collapsed,
  onToggleCollapsed,
}: SchedulerSidebarProps) {
  const [activeView, setActiveView] = useState<SidebarView>("devices");

  return (
    <div className="thin-scrollbar h-full min-h-0 overflow-y-auto pr-1">
      <div
        className={cn(
          "h-full min-h-0",
          collapsed ? "flex justify-end" : "grid grid-rows-[auto,minmax(0,1fr)] gap-2",
        )}
      >
        <Card
          className={cn(
            "glass-panel shrink-0 border-border/70",
            collapsed ? "h-full w-[72px] shrink-0" : "overflow-hidden",
          )}
        >
          <CardContent
            className={cn(
              "p-1.5",
              collapsed
                ? "flex h-full flex-col items-center gap-1.5"
                : "flex min-h-[48px] items-center justify-center gap-1.5 p-1.5",
            )}
          >
            <Button
              size="sm"
              variant="outline"
              className={cn("h-8 w-8 shrink-0 px-0", collapsed && "w-full")}
              onClick={onToggleCollapsed}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>

            {SIDEBAR_VIEWS.map((view) => (
              <Button
                key={view.id}
                size="sm"
                variant={view.id === activeView ? "default" : "ghost"}
                className={cn("h-8 shrink-0 px-0", collapsed ? "w-full justify-center" : "w-8")}
                onClick={() => setActiveView(view.id)}
                title={view.label}
              >
                <view.Icon className="h-4 w-4 shrink-0" />
              </Button>
            ))}
          </CardContent>
        </Card>

        {collapsed ? null : (
          <div className="h-full min-h-0 pb-1">
            {activeView === "devices" ? (
              <DeviceOverviewPanel />
            ) : activeView === "calibration" ? (
              <PumpCalibrationPanel />
            ) : activeView === "setup" ? (
              <PumpSetupPanel />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
