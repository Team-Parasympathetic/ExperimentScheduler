import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls, useCursor, useGLTF } from "@react-three/drei";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { Crosshair, MousePointer2, Pause, Play, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import { FloatingWindow } from "@/components/floating-window";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
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
const PUMP_BODY_WIDTH = 58;
const PUMP_BODY_HEIGHT = 58;
const PUMP_BODY_DEPTH = 90;
const MODEL_SCALE = 0.022;
const PUMP_MODEL_WIDTH = PUMP_BODY_WIDTH * MODEL_SCALE;
const PUMP_MODEL_HEIGHT = PUMP_BODY_HEIGHT * MODEL_SCALE;
const PUMP_MODEL_DEPTH = PUMP_BODY_DEPTH * MODEL_SCALE;
const PUMP_SIDE_SLOT_OFFSET = PUMP_MODEL_WIDTH + 0.12;
const PUMP_VERTICAL_SLOT_OFFSET = PUMP_MODEL_HEIGHT + 0.12;
const PUMP_MODEL_LAYOUT_STORAGE_KEY = "experiment-scheduler:pump-model-layout";
const ARROW_FRONT_OFFSET = new THREE.Vector3(0, 0, 2.2);
const ARROW_HEAD_BLUE = "#0284c7";
const ARROW_TAIL_BLUE = "#bfdbfe";

type CandidateDirection = "left" | "right" | "up" | "down";

interface PumpModelSlot {
  id: string;
  rowId: string;
  x: number;
  y: number;
  z: number;
}

interface CandidatePumpSlot {
  sourceSlotId: string;
  direction: CandidateDirection;
  x: number;
  y: number;
  z: number;
}

interface AssignmentWindowState {
  candidate: CandidatePumpSlot;
  x: number;
  y: number;
}

interface PumpMenuState {
  pumpId: string;
  slotId: string;
  x: number;
  y: number;
}

interface ReassignWindowState {
  slotId: string;
  rowId: string;
  x: number;
  y: number;
}

interface PumpViewportPump {
  id: string;
  slotId: string;
  label: string;
  direction: Direction;
  flowRate: number;
  isActive: boolean;
  x: number;
  y: number;
  z: number;
}

interface PumpModelProps {
  pump: PumpViewportPump;
  isHovered: boolean;
  isSelected: boolean;
  isShiftPressed: boolean;
  isSlotAvailable: (candidate: CandidatePumpSlot) => boolean;
  onHover: (pumpId: string | null) => void;
  onHoverCandidate: (candidate: CandidatePumpSlot | null) => void;
  onOpenAssignment: (candidate: CandidatePumpSlot, x: number, y: number) => void;
  onOpenPumpMenu: (pump: PumpViewportPump, x: number, y: number) => void;
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

function createModelSlotId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `pump-model-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getSlotKey(x: number, y: number, z: number) {
  return `${x.toFixed(3)}:${y.toFixed(3)}:${z.toFixed(3)}`;
}

function getStoredModelSlots(): PumpModelSlot[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const storedSlots = window.localStorage.getItem(PUMP_MODEL_LAYOUT_STORAGE_KEY);
    if (!storedSlots) {
      return [];
    }

    const parsed = JSON.parse(storedSlots);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((slot) => ({
        id: typeof slot.id === "string" ? slot.id : createModelSlotId(),
        rowId: typeof slot.rowId === "string" ? slot.rowId : "",
        x: Number(slot.x),
        y: Number.isFinite(Number(slot.y)) ? Number(slot.y) : 0,
        z: Number(slot.z),
      }))
      .filter((slot) => slot.rowId && Number.isFinite(slot.x) && Number.isFinite(slot.y) && Number.isFinite(slot.z));
  } catch {
    return [];
  }
}

function usePumpRows() {
  const rows = useSchedulerStore((state) => state.rows);
  return useMemo(
    () => rows.filter((row) => row.deviceType === "peristaltic" && !row.isScheduleStatus),
    [rows],
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
      .slice(0, 2);

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

function usePumpViewportModelPumps(
  modelSlots: PumpModelSlot[],
  pumpRows: Row[],
  previewPumpId: string | null,
  isPreviewRunning: boolean,
) {
  const blocks = useSchedulerStore((state) => state.blocks);
  const playheadMs = useSchedulerStore((state) => state.playheadMs);
  const experimentState = useSchedulerStore((state) => state.experimentState);

  return useMemo(() => {
    const pumpRowsById = new Map(pumpRows.map((row) => [row.id, row]));

    return modelSlots.flatMap((slot) => {
      const row = pumpRowsById.get(slot.rowId);
      if (!row) {
        return [];
      }

      const activeBlock = getActiveBlockForRow(row, blocks, playheadMs, experimentState);
      const isPreviewActive = isPreviewRunning && previewPumpId === row.id;

      return [{
        id: row.id,
        slotId: slot.id,
        label: row.name,
        direction: activeBlock?.direction ?? "forward",
        flowRate: activeBlock?.flowRate ?? 320,
        isActive: Boolean(activeBlock) || isPreviewActive,
        x: slot.x,
        y: slot.y,
        z: slot.z,
      }];
    });
  }, [blocks, experimentState, isPreviewRunning, modelSlots, playheadMs, previewPumpId, pumpRows]);
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

function getCandidateSlot(pump: PumpViewportPump, direction: CandidateDirection): CandidatePumpSlot {
  if (direction === "left") {
    return {
      sourceSlotId: pump.slotId,
      direction,
      x: pump.x - PUMP_SIDE_SLOT_OFFSET,
      y: pump.y,
      z: pump.z,
    };
  }

  if (direction === "right") {
    return {
      sourceSlotId: pump.slotId,
      direction,
      x: pump.x + PUMP_SIDE_SLOT_OFFSET,
      y: pump.y,
      z: pump.z,
    };
  }

  if (direction === "up") {
    return {
      sourceSlotId: pump.slotId,
      direction,
      x: pump.x,
      y: pump.y + PUMP_VERTICAL_SLOT_OFFSET,
      z: pump.z,
    };
  }

  return {
    sourceSlotId: pump.slotId,
    direction,
    x: pump.x,
    y: pump.y - PUMP_VERTICAL_SLOT_OFFSET,
    z: pump.z,
  };
}

function createPlaceholderClone(source: THREE.Object3D) {
  const placeholder = source.clone(true);

  placeholder.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) {
      return;
    }

    object.geometry = object.geometry.clone();
    object.material = new THREE.MeshBasicMaterial({
      color: "#0284c7",
      depthTest: true,
      depthWrite: false,
      opacity: 0.18,
      side: THREE.DoubleSide,
      transparent: true,
    });
    object.raycast = () => null;
    object.renderOrder = 2;
  });

  return placeholder;
}

function CandidatePumpPlaceholder({ candidate }: { candidate: CandidatePumpSlot }) {
  const gltf = useGLTF(BODY_MODEL_URL);
  const placeholder = useMemo(() => createPlaceholderClone(gltf.scene), [gltf.scene]);

  return (
    <group position={[candidate.x, candidate.y, candidate.z]} scale={MODEL_SCALE}>
      <PumpBodyOutline body={gltf.scene} color="#0284c7" isSelected />
      <primitive object={placeholder} position={BODY_CENTER.clone().multiplyScalar(-1).toArray()} />
    </group>
  );
}

function CandidateZone({
  direction,
  isShiftPressed,
  isSlotAvailable,
  onHoverCandidate,
  onOpenAssignment,
  pump,
}: {
  direction: CandidateDirection;
  isShiftPressed: boolean;
  isSlotAvailable: (candidate: CandidatePumpSlot) => boolean;
  onHoverCandidate: (candidate: CandidatePumpSlot | null) => void;
  onOpenAssignment: (candidate: CandidatePumpSlot, x: number, y: number) => void;
  pump: PumpViewportPump;
}) {
  const candidate = getCandidateSlot(pump, direction);
  const shouldAcceptPointer = isShiftPressed && isSlotAvailable(candidate);

  if (!isShiftPressed) {
    return null;
  }

  const zonePosition =
    direction === "left"
      ? [-PUMP_BODY_WIDTH / 2 - 10, 0, 0]
      : direction === "right"
        ? [PUMP_BODY_WIDTH / 2 + 10, 0, 0]
        : direction === "up"
          ? [0, PUMP_BODY_HEIGHT / 2 + 10, 0]
          : [0, -PUMP_BODY_HEIGHT / 2 - 10, 0];
  const zoneSize =
    direction === "up" || direction === "down"
      ? [PUMP_BODY_WIDTH, 24, PUMP_BODY_DEPTH]
      : [24, PUMP_BODY_HEIGHT, PUMP_BODY_DEPTH];

  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!shouldAcceptPointer) {
      return;
    }

    event.stopPropagation();
    onHoverCandidate(candidate);
  };

  const handlePointerOut = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onHoverCandidate(null);
  };

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    if (!shouldAcceptPointer) {
      return;
    }

    event.stopPropagation();
    onOpenAssignment(candidate, event.clientX, event.clientY);
  };

  return (
    <mesh
      position={zonePosition as [number, number, number]}
      onClick={handleClick}
      onPointerMove={handlePointerMove}
      onPointerOut={handlePointerOut}
      onPointerOver={handlePointerMove}
    >
      <boxGeometry args={zoneSize as [number, number, number]} />
      <meshBasicMaterial depthWrite={false} opacity={0} transparent />
    </mesh>
  );
}

function PumpModel({
  isHovered,
  isSelected,
  isShiftPressed,
  isSlotAvailable,
  onHover,
  onHoverCandidate,
  onOpenAssignment,
  onOpenPumpMenu,
  onSelect,
  pump,
}: PumpModelProps) {
  const gltf = useGLTF(BODY_MODEL_URL);
  const body = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  const hitboxRef = useRef<THREE.Mesh>(null);
  const getCandidateFromPointer = (event: ThreeEvent<PointerEvent | MouseEvent>) => {
    if (!hitboxRef.current) {
      return null;
    }

    const localPoint = event.point.clone();
    hitboxRef.current.worldToLocal(localPoint);

    const edgeDistances: Array<{ direction: CandidateDirection; distance: number }> = [
      {
        direction: "left",
        distance: Math.abs(localPoint.x + PUMP_BODY_WIDTH / 2),
      },
      {
        direction: "right",
        distance: Math.abs(PUMP_BODY_WIDTH / 2 - localPoint.x),
      },
      {
        direction: "up",
        distance: Math.abs(PUMP_BODY_HEIGHT / 2 - localPoint.y),
      },
      {
        direction: "down",
        distance: Math.abs(localPoint.y + PUMP_BODY_HEIGHT / 2),
      },
    ];
    const nearestEdge = edgeDistances.sort((left, right) => left.distance - right.distance)[0];
    const candidate = getCandidateSlot(pump, nearestEdge.direction);

    return isSlotAvailable(candidate) ? candidate : null;
  };
  const handlePointerOver = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onHover(pump.id);
  };
  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!isShiftPressed) {
      return;
    }

    event.stopPropagation();
    onHoverCandidate(getCandidateFromPointer(event));
  };
  const handlePointerOut = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onHover(null);
    onHoverCandidate(null);
  };
  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();

    if (isShiftPressed) {
      const candidate = getCandidateFromPointer(event);
      if (candidate) {
        onOpenAssignment(candidate, event.clientX, event.clientY);
      }

      return;
    }

    onSelect(pump.id);
  };
  const handleContextMenu = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    event.nativeEvent.preventDefault();
    onOpenPumpMenu(pump, event.clientX, event.clientY);
  };
  const outlineColor = isSelected ? "#0284c7" : "#f97316";
  const shouldShowOutline = isHovered || isSelected;

  return (
    <group
      position={[pump.x, pump.y, pump.z]}
      scale={MODEL_SCALE}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onPointerMove={handlePointerMove}
      onPointerOut={handlePointerOut}
      onPointerOver={handlePointerOver}
    >
      <group>
        {shouldShowOutline ? (
          <PumpBodyOutline body={body} color={outlineColor} isSelected={isSelected} />
        ) : null}
        <primitive object={body} position={BODY_CENTER.clone().multiplyScalar(-1).toArray()} />
        <PumpHead direction={pump.direction} flowRate={pump.flowRate} isActive={pump.isActive} />
        {pump.isActive ? (
          <PumpRotationArrow direction={pump.direction} isActive={pump.isActive} />
        ) : null}
      </group>
      {(["left", "right", "up", "down"] as CandidateDirection[]).map((direction) => (
        <CandidateZone
          key={`${pump.slotId}-${direction}`}
          direction={direction}
          isShiftPressed={isShiftPressed}
          isSlotAvailable={isSlotAvailable}
          onHoverCandidate={onHoverCandidate}
          onOpenAssignment={onOpenAssignment}
          pump={pump}
        />
      ))}
      <mesh
        ref={hitboxRef}
        position={[0, 0, 0]}
        raycast={() => undefined}
      >
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
  activeCandidate,
  hoveredPumpId,
  isShiftPressed,
  pumps,
  resetViewNonce,
  selectedPumpId,
  onHover,
  onHoverCandidate,
  onOpenAssignment,
  onOpenPumpMenu,
  onSelect,
}: {
  activeCandidate: CandidatePumpSlot | null;
  hoveredPumpId: string | null;
  isShiftPressed: boolean;
  pumps: PumpViewportPump[];
  resetViewNonce: number;
  selectedPumpId: string | null;
  onHover: (pumpId: string | null) => void;
  onHoverCandidate: (candidate: CandidatePumpSlot | null) => void;
  onOpenAssignment: (candidate: CandidatePumpSlot, x: number, y: number) => void;
  onOpenPumpMenu: (pump: PumpViewportPump, x: number, y: number) => void;
  onSelect: (pumpId: string) => void;
}) {
  const controlsRef = useRef<any>(null);
  const hasInitializedViewRef = useRef(false);
  const lastResetViewNonceRef = useRef(resetViewNonce);
  const { camera } = useThree();
  const occupiedSlotKeys = useMemo(
    () => new Set(pumps.map((pump) => getSlotKey(pump.x, pump.y, pump.z))),
    [pumps],
  );
  const sceneCenter = useMemo(() => {
    if (pumps.length === 0) {
      return new THREE.Vector3(0, 0.12, 0.35);
    }

    const minX = Math.min(...pumps.map((pump) => pump.x));
    const maxX = Math.max(...pumps.map((pump) => pump.x));
    const minY = Math.min(...pumps.map((pump) => pump.y));
    const maxY = Math.max(...pumps.map((pump) => pump.y));
    const minZ = Math.min(...pumps.map((pump) => pump.z));
    const maxZ = Math.max(...pumps.map((pump) => pump.z));

    return new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2 + 0.12, (minZ + maxZ) / 2 + 0.35);
  }, [pumps]);
  const fitDistance = useMemo(() => {
    if (pumps.length === 0) {
      return 5.6;
    }

    const minX = Math.min(...pumps.map((pump) => pump.x));
    const maxX = Math.max(...pumps.map((pump) => pump.x));
    const minY = Math.min(...pumps.map((pump) => pump.y));
    const maxY = Math.max(...pumps.map((pump) => pump.y));
    const minZ = Math.min(...pumps.map((pump) => pump.z));
    const maxZ = Math.max(...pumps.map((pump) => pump.z));
    const span = Math.max(
      maxX - minX + PUMP_MODEL_WIDTH,
      maxY - minY + PUMP_MODEL_HEIGHT,
      maxZ - minZ + PUMP_MODEL_DEPTH,
      1,
    );

    return THREE.MathUtils.clamp(5.8 + span * 1.25, 5.8, 14.5);
  }, [pumps]);
  const isSlotAvailable = useCallback(
    (candidate: CandidatePumpSlot) => !occupiedSlotKeys.has(getSlotKey(candidate.x, candidate.y, candidate.z)),
    [occupiedSlotKeys],
  );

  useCursor(Boolean(hoveredPumpId) || Boolean(activeCandidate));

  useEffect(() => {
    const shouldResetView =
      !hasInitializedViewRef.current ||
      resetViewNonce !== lastResetViewNonceRef.current;

    if (!shouldResetView) {
      return;
    }

    hasInitializedViewRef.current = true;
    lastResetViewNonceRef.current = resetViewNonce;
    const controls = controlsRef.current;

    camera.position.set(
      sceneCenter.x + fitDistance * 0.62,
      sceneCenter.y + fitDistance * 0.42,
      sceneCenter.z + fitDistance,
    );
    camera.lookAt(sceneCenter);

    if (controls) {
      controls.target.copy(sceneCenter);
      controls.update();
      controls.saveState();
    }
  }, [camera, fitDistance, resetViewNonce, sceneCenter]);

  return (
    <>
      <color attach="background" args={["#eaf2f6"]} />
      <ambientLight intensity={1.1} />
      <directionalLight intensity={2.5} position={[3, 4, 5]} />
      <directionalLight intensity={1.2} position={[-4, 2, 2]} />

      <group rotation={[-0.08, -0.22, 0]}>
        {pumps.map((pump) => (
          <PumpModel
            key={pump.id}
            isHovered={hoveredPumpId === pump.id}
            isSelected={selectedPumpId === pump.id}
            isShiftPressed={isShiftPressed}
            isSlotAvailable={isSlotAvailable}
            onHover={onHover}
            onHoverCandidate={onHoverCandidate}
            onOpenAssignment={onOpenAssignment}
            onOpenPumpMenu={onOpenPumpMenu}
            onSelect={onSelect}
            pump={pump}
          />
        ))}
        {activeCandidate && isSlotAvailable(activeCandidate) ? (
          <CandidatePumpPlaceholder candidate={activeCandidate} />
        ) : null}
      </group>

      <OrbitControls
        ref={controlsRef}
        enableDamping
        makeDefault
        maxDistance={18}
        minDistance={1.6}
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
  const [isShiftPressed, setIsShiftPressed] = useState(false);
  const [activeCandidate, setActiveCandidate] = useState<CandidatePumpSlot | null>(null);
  const [assignmentWindow, setAssignmentWindow] = useState<AssignmentWindowState | null>(null);
  const [reassignWindow, setReassignWindow] = useState<ReassignWindowState | null>(null);
  const [pumpMenu, setPumpMenu] = useState<PumpMenuState | null>(null);
  const [assignmentRowId, setAssignmentRowId] = useState("");
  const [resetViewNonce, setResetViewNonce] = useState(0);
  const pumpRows = usePumpRows();
  const [modelSlots, setModelSlots] = useState<PumpModelSlot[]>(getStoredModelSlots);
  const previewPumpId = selectedPumpId ?? modelSlots[0]?.rowId ?? null;
  const pumps = usePumpViewportModelPumps(
    modelSlots,
    pumpRows,
    previewPumpId,
    isPreviewRunning,
  );
  const selectedPump = pumps.find((pump) => pump.id === selectedPumpId) ?? pumps[0] ?? null;
  const assignedRowIds = useMemo(
    () => new Set(modelSlots.map((slot) => slot.rowId)),
    [modelSlots],
  );
  const getDefaultAssignmentRowId = useCallback(() => {
    return pumpRows.find((row) => !assignedRowIds.has(row.id))?.id ?? pumpRows[0]?.id ?? "";
  }, [assignedRowIds, pumpRows]);

  useEffect(() => {
    const pumpRowIds = new Set(pumpRows.map((row) => row.id));

    setModelSlots((currentSlots) => {
      const nextSlots = currentSlots.filter((slot) => pumpRowIds.has(slot.rowId));

      if (pumpRows.length === 0) {
        return [];
      }

      if (nextSlots.length > 0) {
        return nextSlots;
      }

      return [{
        id: createModelSlotId(),
        rowId: pumpRows[0].id,
        x: 0,
        y: 0,
        z: 0,
      }];
    });
  }, [pumpRows]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PUMP_MODEL_LAYOUT_STORAGE_KEY, JSON.stringify(modelSlots));
    } catch {
      // The viewport still works when local storage is unavailable.
    }
  }, [modelSlots]);

  useEffect(() => {
    const pumpIds = new Set(pumps.map((pump) => pump.id));
    if (selectedPumpId && !pumpIds.has(selectedPumpId)) {
      setSelectedPumpId(null);
    }
  }, [pumps, selectedPumpId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        setIsShiftPressed(true);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        setIsShiftPressed(false);
        setActiveCandidate(null);
      }
    };

    const handleBlur = () => {
      setIsShiftPressed(false);
      setActiveCandidate(null);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  const openAssignmentWindow = useCallback(
    (candidate: CandidatePumpSlot, x: number, y: number) => {
      setAssignmentWindow({ candidate, x, y });
      setReassignWindow(null);
      setPumpMenu(null);
      setAssignmentRowId(getDefaultAssignmentRowId());
    },
    [getDefaultAssignmentRowId],
  );
  const openPumpMenu = useCallback((pump: PumpViewportPump, x: number, y: number) => {
    setPumpMenu({ pumpId: pump.id, slotId: pump.slotId, x, y });
    setAssignmentWindow(null);
    setReassignWindow(null);
    setSelectedPumpId(pump.id);
  }, []);
  const closePumpMenu = useCallback(() => setPumpMenu(null), []);
  const openReassignWindow = useCallback(() => {
    if (!pumpMenu) {
      return;
    }

    setReassignWindow({
      slotId: pumpMenu.slotId,
      rowId: pumpMenu.pumpId,
      x: pumpMenu.x,
      y: pumpMenu.y,
    });
    setPumpMenu(null);
  }, [pumpMenu]);
  const reassignPumpModel = useCallback(() => {
    if (!reassignWindow || !reassignWindow.rowId) {
      return;
    }

    setModelSlots((currentSlots) => {
      const targetSlot = currentSlots.find((slot) => slot.id === reassignWindow.slotId);

      if (!targetSlot) {
        return currentSlots;
      }

      const occupiedSlot = currentSlots.find(
        (slot) =>
          slot.id !== reassignWindow.slotId &&
          slot.rowId === reassignWindow.rowId,
      );

      return currentSlots.map((slot) => {
        if (slot.id === reassignWindow.slotId) {
          return { ...slot, rowId: reassignWindow.rowId };
        }

        if (slot.id === occupiedSlot?.id) {
          return { ...slot, rowId: targetSlot.rowId };
        }

        return slot;
      });
    });
    setSelectedPumpId(reassignWindow.rowId);
    setReassignWindow(null);
  }, [reassignWindow]);
  const deletePumpModel = useCallback(() => {
    if (!pumpMenu) {
      return;
    }

    setModelSlots((currentSlots) => {
      if (currentSlots.length <= 1) {
        return currentSlots;
      }

      return currentSlots.filter((slot) => slot.id !== pumpMenu.slotId);
    });
    if (selectedPumpId === pumpMenu.pumpId) {
      setSelectedPumpId(null);
    }
    setPumpMenu(null);
  }, [pumpMenu, selectedPumpId]);

  const assignCandidateSlot = useCallback(() => {
    if (!assignmentWindow || !assignmentRowId) {
      return;
    }

    const { candidate } = assignmentWindow;
    const candidateKey = getSlotKey(candidate.x, candidate.y, candidate.z);

    setModelSlots((currentSlots) => [
      ...currentSlots.filter(
        (slot) => slot.rowId !== assignmentRowId && getSlotKey(slot.x, slot.y, slot.z) !== candidateKey,
      ),
      {
        id: createModelSlotId(),
        rowId: assignmentRowId,
        x: candidate.x,
        y: candidate.y,
        z: candidate.z,
      },
    ]);
    setSelectedPumpId(assignmentRowId);
    setAssignmentWindow(null);
    setActiveCandidate(null);
  }, [assignmentRowId, assignmentWindow]);
  const canDeletePumpModel = modelSlots.length > 1;

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
            aria-label="Recenter 3D view"
            className="h-8 w-8 px-0"
            size="sm"
            title="Recenter 3D view"
            variant="ghost"
            onClick={() => setResetViewNonce((current) => current + 1)}
          >
            <Crosshair className="h-4 w-4" />
          </Button>
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
        <Canvas
          camera={{ fov: 34, position: [5.2, 3.1, 7.4] }}
          shadows
          onPointerMissed={(event) => {
            if (event.type !== "click") {
              return;
            }

            setSelectedPumpId(null);
            setActiveCandidate(null);
            setAssignmentWindow(null);
            setReassignWindow(null);
            setPumpMenu(null);
          }}
        >
          <Suspense fallback={<LoadingModels />}>
            <PumpScene
              activeCandidate={activeCandidate}
              hoveredPumpId={hoveredPumpId}
              isShiftPressed={isShiftPressed}
              pumps={pumps}
              resetViewNonce={resetViewNonce}
              selectedPumpId={selectedPumpId}
              onHover={setHoveredPumpId}
              onHoverCandidate={setActiveCandidate}
              onOpenAssignment={openAssignmentWindow}
              onOpenPumpMenu={openPumpMenu}
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

      {assignmentWindow ? (
        <FloatingWindow
          title="Assign Pump Model"
          subtitle="Select Channel"
          x={assignmentWindow.x}
          y={assignmentWindow.y}
          width={320}
          onClose={() => setAssignmentWindow(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAssignmentWindow(null)}>
                Cancel
              </Button>
              <Button size="sm" disabled={!assignmentRowId} onClick={assignCandidateSlot}>
                Assign
              </Button>
            </div>
          }
        >
          <Select
            value={assignmentRowId}
            onChange={(event) => setAssignmentRowId(event.target.value)}
          >
            <option value="" disabled>
              Select pump channel
            </option>
            {pumpRows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
                {assignedRowIds.has(row.id) ? " (shown)" : ""}
              </option>
            ))}
          </Select>
        </FloatingWindow>
      ) : null}

      {reassignWindow ? (
        <FloatingWindow
          title="Reassign Pump Model"
          subtitle="Select Channel"
          x={reassignWindow.x}
          y={reassignWindow.y}
          width={320}
          onClose={() => setReassignWindow(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setReassignWindow(null)}>
                Cancel
              </Button>
              <Button size="sm" disabled={!reassignWindow.rowId} onClick={reassignPumpModel}>
                Reassign
              </Button>
            </div>
          }
        >
          <Select
            value={reassignWindow.rowId}
            onChange={(event) =>
              setReassignWindow((current) =>
                current ? { ...current, rowId: event.target.value } : current,
              )
            }
          >
            <option value="" disabled>
              Select pump channel
            </option>
            {pumpRows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
                {assignedRowIds.has(row.id) && row.id !== reassignWindow.rowId ? " (shown)" : ""}
              </option>
            ))}
          </Select>
        </FloatingWindow>
      ) : null}

      {pumpMenu ? (
        <FloatingWindow
          title="Pump Model"
          subtitle={pumps.find((pump) => pump.slotId === pumpMenu.slotId)?.label ?? "Pump"}
          x={pumpMenu.x}
          y={pumpMenu.y}
          width={280}
          onClose={closePumpMenu}
        >
          <div className="space-y-2">
            <Button
              className="w-full justify-start"
              size="sm"
              variant="outline"
              onClick={openReassignWindow}
            >
              <RefreshCw className="h-4 w-4" />
              Reassign Pump
            </Button>
            <Button
              className="w-full justify-start"
              disabled={!canDeletePumpModel}
              size="sm"
              variant="destructive"
              onClick={deletePumpModel}
              title={canDeletePumpModel ? "Delete model" : "At least one pump model must remain"}
            >
              <Trash2 className="h-4 w-4" />
              Delete Model
            </Button>
          </div>
        </FloatingWindow>
      ) : null}
    </div>
  );
}

useGLTF.preload(BODY_MODEL_URL);
useGLTF.preload(HEAD_MODEL_URL);
useGLTF.preload(ARROW_MODEL_URL);
