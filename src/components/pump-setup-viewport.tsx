import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Html, OrbitControls, useCursor, useGLTF } from "@react-three/drei";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { MousePointer2, Pause, Play, RotateCcw } from "lucide-react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import { Button } from "@/components/ui/button";
import arrowModelUrl from "@/assets/models/pump-arrow.glb?url";
import bodyModelUrl from "@/assets/models/pump-body.glb?url";
import headModelUrl from "@/assets/models/pump-head.glb?url";
import { getBlockEnd } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useSchedulerStore } from "@/store/scheduler-store";
import type { Block, Direction, Row } from "@/types/scheduler";

const BODY_MODEL_URL = bodyModelUrl;
const HEAD_MODEL_URL = headModelUrl;
const ARROW_MODEL_URL = arrowModelUrl;

const BODY_CENTER = new THREE.Vector3(25, 25, -40);
const HEAD_CENTER = new THREE.Vector3(24.9966, 25, -3.5);
const HEAD_PIVOT = HEAD_CENTER.clone().sub(BODY_CENTER);
const MODEL_SCALE = 0.022;
const PUMP_SPACING = 1.55;
const PUMP_LIMIT = 2;
const ARROW_FRONT_OFFSET = new THREE.Vector3(0, 0, 2.2);
const ARROW_HEAD_BLUE = "#0284c7";
const ARROW_TAIL_BLUE = "#bfdbfe";

interface PumpViewportPump {
  id: string;
  label: string;
  direction: Direction;
  flowRate: number;
  isActive: boolean;
}

interface PumpModelProps {
  pump: PumpViewportPump;
  index: number;
  isHovered: boolean;
  isSelected: boolean;
  onHover: (pumpId: string | null) => void;
  onSelect: (pumpId: string) => void;
}

function getActiveBlockForRow(
  row: Row,
  blocks: Block[],
  playheadMs: number,
  experimentState: string,
) {
  if (experimentState !== "running") {
    return null;
  }

  return (
    blocks.find(
      (block) =>
        block.rowId === row.id &&
        block.startMs <= playheadMs &&
        playheadMs < getBlockEnd(block),
    ) ?? null
  );
}

function usePumpViewportPumps(previewPumpId: string | null, isPreviewRunning: boolean) {
  const rows = useSchedulerStore((state) => state.rows);
  const blocks = useSchedulerStore((state) => state.blocks);
  const playheadMs = useSchedulerStore((state) => state.playheadMs);
  const experimentState = useSchedulerStore((state) => state.experimentState);

  return useMemo(() => {
    const pumpRows = rows
      .filter((row) => row.deviceType === "peristaltic" && !row.isScheduleStatus)
      .slice(0, PUMP_LIMIT);

    return pumpRows.map((row, index) => {
      const activeBlock = getActiveBlockForRow(row, blocks, playheadMs, experimentState);
      const isPreviewActive = isPreviewRunning && (previewPumpId === row.id || (!previewPumpId && index === 0));

      return {
        id: row.id,
        label: row.hardwareId === null || row.hardwareId === undefined
          ? row.name
          : `${row.name} · HW ${row.hardwareId}`,
        direction: activeBlock?.direction ?? "forward",
        flowRate: activeBlock?.flowRate ?? 320,
        isActive: Boolean(activeBlock) || isPreviewActive,
      };
    });
  }, [blocks, experimentState, isPreviewRunning, playheadMs, previewPumpId, rows]);
}

function PumpHead({ direction, flowRate, isActive }: Pick<PumpViewportPump, "direction" | "flowRate" | "isActive">) {
  const gltf = useGLTF(HEAD_MODEL_URL);
  const head = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  const pivotRef = useRef<THREE.Group>(null);

  useFrame((_, delta) => {
    if (!isActive || !pivotRef.current) {
      return;
    }

    const directionMultiplier = direction === "reverse" ? -1 : 1;
    const speed = THREE.MathUtils.clamp(flowRate / 85, 1.2, 7.5);
    pivotRef.current.rotation.z += delta * speed * directionMultiplier;
  });

  return (
    <group ref={pivotRef} position={HEAD_PIVOT.toArray()}>
      <primitive object={head} position={HEAD_CENTER.clone().multiplyScalar(-1).toArray()} />
    </group>
  );
}

function createArrowMaterial(direction: Direction, isActive: boolean) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTargetLeft: { value: direction === "forward" ? 1 : 0 },
      uBaseAlpha: { value: isActive ? 0.22 : 0.14 },
      uPeakAlpha: { value: isActive ? 0.92 : 0.68 },
      uHeadColor: { value: new THREE.Color(ARROW_HEAD_BLUE) },
      uTailColor: { value: new THREE.Color(ARROW_TAIL_BLUE) },
    },
    vertexShader: `
      varying vec3 vPosition;

      void main() {
        vPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uBaseAlpha;
      uniform float uPeakAlpha;
      uniform float uTargetLeft;
      uniform vec3 uHeadColor;
      uniform vec3 uTailColor;
      varying vec3 vPosition;

      void main() {
        float leftProgress = 1.0 - clamp(vPosition.x / 50.0, 0.0, 1.0);
        float directionalProgress = mix(1.0 - leftProgress, leftProgress, uTargetLeft);
        float gradient = smoothstep(0.0, 1.0, directionalProgress);
        float alpha = mix(uBaseAlpha, uPeakAlpha, gradient);
        vec3 color = mix(uTailColor, uHeadColor, gradient);
        gl_FragColor = vec4(color, alpha);
      }
    `,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    transparent: true,
  });
}

function createArrowClone(source: THREE.Object3D, direction: Direction, isActive: boolean) {
  const arrow = source.clone(true);

  arrow.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) {
      return;
    }

    object.geometry = object.geometry.clone();
    object.material = createArrowMaterial(direction, isActive);
    object.raycast = () => null;
    object.renderOrder = 4;
  });

  return arrow;
}

function PumpRotationArrow({
  direction,
  isActive,
}: Pick<PumpViewportPump, "direction" | "isActive">) {
  const gltf = useGLTF(ARROW_MODEL_URL);
  const arrow = useMemo(
    () => createArrowClone(gltf.scene, direction, isActive),
    [direction, gltf.scene, isActive],
  );

  return (
    <primitive
      object={arrow}
      position={BODY_CENTER.clone().multiplyScalar(-1).add(ARROW_FRONT_OFFSET).toArray()}
    />
  );
}

interface HaloLayer {
  opacity: number;
  scale: number;
}

const HOVER_HALO_LAYERS: HaloLayer[] = [
  { scale: 1.025, opacity: 0.2 },
  { scale: 1.055, opacity: 0.11 },
  { scale: 1.09, opacity: 0.055 },
];
const SELECTED_HALO_LAYERS: HaloLayer[] = [
  { scale: 1.03, opacity: 0.26 },
  { scale: 1.065, opacity: 0.15 },
  { scale: 1.105, opacity: 0.075 },
];

function createOutlineClone(source: THREE.Object3D, color: string, opacity: number) {
  const outline = source.clone(true);

  outline.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) {
      return;
    }

    object.geometry = object.geometry.clone();
    object.material = new THREE.MeshBasicMaterial({
      color,
      depthTest: true,
      depthWrite: false,
      side: THREE.BackSide,
      transparent: true,
      opacity,
    });
    object.raycast = () => null;
    object.renderOrder = 3;
  });

  return outline;
}

function PumpBodyOutline({
  body,
  color,
  isSelected,
}: {
  body: THREE.Object3D;
  color: string;
  isSelected: boolean;
}) {
  const layers = isSelected ? SELECTED_HALO_LAYERS : HOVER_HALO_LAYERS;
  const outlines = useMemo(
    () => layers.map((layer) => createOutlineClone(body, color, layer.opacity)),
    [body, color, layers],
  );

  return (
    <>
      {outlines.map((outline, index) => {
        const layer = layers[index];

        return (
          <group key={`${color}-${layer.scale}`} scale={[layer.scale, layer.scale, layer.scale]}>
            <primitive object={outline} position={BODY_CENTER.clone().multiplyScalar(-1).toArray()} />
          </group>
        );
      })}
    </>
  );
}

function PumpModel({
  index,
  isHovered,
  isSelected,
  onHover,
  onSelect,
  pump,
}: PumpModelProps) {
  const gltf = useGLTF(BODY_MODEL_URL);
  const body = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  const x = (index - 0.5) * PUMP_SPACING;
  const handlePointerOver = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onHover(pump.id);
  };
  const handlePointerOut = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onHover(null);
  };
  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    onSelect(pump.id);
  };
  const outlineColor = isSelected ? "#0284c7" : "#f97316";
  const shouldShowOutline = isHovered || isSelected;

  return (
    <group
      position={[x, 0, 0]}
      scale={MODEL_SCALE}
      onClick={handleClick}
      onPointerOut={handlePointerOut}
      onPointerOver={handlePointerOver}
    >
      <group>
        {shouldShowOutline ? (
          <PumpBodyOutline body={body} color={outlineColor} isSelected={isSelected} />
        ) : null}
        <primitive object={body} position={BODY_CENTER.clone().multiplyScalar(-1).toArray()} />
        <PumpHead direction={pump.direction} flowRate={pump.flowRate} isActive={pump.isActive} />
        <PumpRotationArrow direction={pump.direction} isActive={pump.isActive} />
      </group>
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[58, 58, 90]} />
        <meshBasicMaterial
          color={isSelected ? "#0284c7" : "#f97316"}
          transparent
          opacity={shouldShowOutline ? 0.035 : 0}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function PumpScene({
  hoveredPumpId,
  pumps,
  selectedPumpId,
  onHover,
  onSelect,
}: {
  hoveredPumpId: string | null;
  pumps: PumpViewportPump[];
  selectedPumpId: string | null;
  onHover: (pumpId: string | null) => void;
  onSelect: (pumpId: string) => void;
}) {
  useCursor(Boolean(hoveredPumpId));

  return (
    <>
      <color attach="background" args={["#eaf2f6"]} />
      <ambientLight intensity={1.1} />
      <directionalLight intensity={2.5} position={[3, 4, 5]} />
      <directionalLight intensity={1.2} position={[-4, 2, 2]} />

      <group rotation={[-0.08, -0.22, 0]}>
        <mesh position={[0, -0.72, -0.08]} receiveShadow>
          <boxGeometry args={[3.65, 0.08, 2.15]} />
          <meshStandardMaterial color="#d6e1e8" metalness={0.15} roughness={0.42} />
        </mesh>
        {pumps.map((pump, index) => (
          <PumpModel
            key={pump.id}
            index={index}
            isHovered={hoveredPumpId === pump.id}
            isSelected={selectedPumpId === pump.id}
            onHover={onHover}
            onSelect={onSelect}
            pump={pump}
          />
        ))}
      </group>

      <OrbitControls
        enableDamping
        makeDefault
        maxDistance={7}
        minDistance={2.4}
        target={[0, 0.1, 0.35]}
      />
      <EffectComposer>
        <Bloom
          intensity={0.12}
          luminanceSmoothing={0.8}
          luminanceThreshold={0.92}
          mipmapBlur
        />
      </EffectComposer>
    </>
  );
}

function LoadingModels() {
  return (
    <Html center>
      <div className="rounded-md border border-white/70 bg-white/85 px-3 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 shadow-sm backdrop-blur">
        Loading Models
      </div>
    </Html>
  );
}

interface PumpSetupViewportProps {
  className?: string;
}

export function PumpSetupViewport({ className }: PumpSetupViewportProps) {
  const [hoveredPumpId, setHoveredPumpId] = useState<string | null>(null);
  const [selectedPumpId, setSelectedPumpId] = useState<string | null>(null);
  const [isPreviewRunning, setIsPreviewRunning] = useState(false);
  const previewPumpId = selectedPumpId;
  const pumps = usePumpViewportPumps(previewPumpId, isPreviewRunning);
  const selectedPump = pumps.find((pump) => pump.id === selectedPumpId) ?? pumps[0] ?? null;

  return (
    <div
      className={cn(
        "flex h-full min-h-[220px] flex-col overflow-hidden rounded-lg border border-border/70 bg-white",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">
            {selectedPump?.label ?? "Pump Setup"}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                selectedPump?.isActive ? "bg-teal-500 shadow-[0_0_0_3px_rgba(20,184,166,0.16)]" : "bg-slate-300",
              )}
            />
            {selectedPump?.isActive ? "Running" : "Idle"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label={isPreviewRunning ? "Pause preview rotation" : "Preview selected pump rotation"}
            className="h-8 w-8 px-0"
            size="sm"
            title={isPreviewRunning ? "Pause preview rotation" : "Preview selected pump rotation"}
            variant={isPreviewRunning ? "secondary" : "ghost"}
            onClick={() => setIsPreviewRunning((current) => !current)}
          >
            {isPreviewRunning ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <Button
            aria-label="Clear selected pump"
            className="h-8 w-8 px-0"
            disabled={!selectedPumpId}
            size="sm"
            title="Clear selected pump"
            variant="ghost"
            onClick={() => setSelectedPumpId(null)}
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <Canvas camera={{ fov: 38, position: [3.0, 1.85, 4.6] }} shadows>
          <Suspense fallback={<LoadingModels />}>
            <PumpScene
              hoveredPumpId={hoveredPumpId}
              pumps={pumps}
              selectedPumpId={selectedPumpId}
              onHover={setHoveredPumpId}
              onSelect={setSelectedPumpId}
            />
          </Suspense>
        </Canvas>
        <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-md border border-white/70 bg-white/82 px-2.5 py-1.5 text-xs font-semibold text-slate-600 shadow-sm backdrop-blur">
          <MousePointer2 className="h-3.5 w-3.5" />
          {hoveredPumpId
            ? pumps.find((pump) => pump.id === hoveredPumpId)?.label
            : "Hover body"}
        </div>
      </div>
    </div>
  );
}

useGLTF.preload(BODY_MODEL_URL);
useGLTF.preload(HEAD_MODEL_URL);
useGLTF.preload(ARROW_MODEL_URL);
