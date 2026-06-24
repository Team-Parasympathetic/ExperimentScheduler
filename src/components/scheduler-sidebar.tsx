import { useState } from "react";
import {
  Box,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  ListTree,
  PanelLeft,
  PanelRight,
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
  dockSide: "left" | "right";
  onToggleCollapsed: () => void;
  onToggleDockSide: () => void;
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
  dockSide,
  onToggleCollapsed,
  onToggleDockSide,
}: SchedulerSidebarProps) {
  const [activeView, setActiveView] = useState<SidebarView>("devices");
  const CollapseIcon = collapsed
    ? dockSide === "left"
      ? ChevronRight
      : ChevronLeft
    : dockSide === "left"
      ? ChevronLeft
      : ChevronRight;
  const DockIcon = dockSide === "left" ? PanelRight : PanelLeft;

  return (
    <div
      className={cn(
        "thin-scrollbar h-full min-h-0 w-full min-w-0 overflow-y-auto",
        collapsed ? "overflow-x-hidden" : "pr-1",
      )}
    >
      <div
        className={cn(
          "h-full min-h-0 w-full min-w-0",
          collapsed ? "flex justify-end overflow-hidden" : "grid grid-rows-[auto,minmax(0,1fr)] gap-2",
        )}
      >
        <Card
          className={cn(
            "glass-panel min-w-0 shrink-0 border-border/70",
            collapsed ? "h-full w-[72px] overflow-hidden" : "w-full overflow-hidden",
          )}
        >
          <CardContent
            className={cn(
              "min-w-0 p-1.5",
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
              <CollapseIcon className="h-4 w-4" />
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className={cn("h-8 w-8 shrink-0 px-0", collapsed && "w-full justify-center")}
              onClick={onToggleDockSide}
              title={dockSide === "left" ? "Dock sidebar right" : "Dock sidebar left"}
            >
              <DockIcon className="h-4 w-4" />
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
          <div className="h-full min-h-0 w-full min-w-0 pb-1">
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
