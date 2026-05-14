import { useCallback, useEffect, useMemo, useState } from "react";
import ReactFlow, {
  Node,
  Edge,
  Controls,
  Background,
  MiniMap,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  useReactFlow,
  MarkerType,
  NodeProps,
  Handle,
  Position,
} from "reactflow";
import "reactflow/dist/style.css";

interface MindMapNode {
  title?: string;
  label?: string;
  children?: MindMapNode[];
}

interface NodeData {
  label: string;
  depth: number;
  branchColor: string;
  hasChildren: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}

interface Props {
  data: MindMapNode;
}

const NODE_W = 160;
const H_GAP = 40;
const V_SPACING = 140;

const BRANCH_COLORS = [
  "#0972d3",
  "#037f0c",
  "#7b2d8b",
  "#c44d00",
  "#c01818",
  "#00788a",
  "#5a4fcf",
];

function subtreeWidth(
  node: MindMapNode,
  nodeId: string,
  expandedIds: Set<string>
): number {
  const children = node.children ?? [];
  if (children.length === 0 || !expandedIds.has(nodeId))
    return NODE_W + H_GAP;
  return children.reduce(
    (sum, c, i) => sum + subtreeWidth(c, `${nodeId}-${i}`, expandedIds),
    0
  );
}

function buildGraph(
  root: MindMapNode,
  expandedIds: Set<string>,
  onToggle: (id: string) => void
): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const nodes: Node<NodeData>[] = [];
  const edges: Edge[] = [];

  function traverse(
    node: MindMapNode,
    nodeId: string,
    parentId: string | null,
    depth: number,
    centerX: number,
    color: string
  ) {
    const label = node.title ?? node.label ?? "?";
    const children = node.children ?? [];
    const hasChildren = children.length > 0;
    const isExpanded = expandedIds.has(nodeId);

    nodes.push({
      id: nodeId,
      type: "mindmap",
      data: {
        label,
        depth,
        branchColor: color,
        hasChildren,
        isExpanded,
        onToggle: () => onToggle(nodeId),
      },
      position: { x: centerX - NODE_W / 2, y: depth * V_SPACING },
    });

    if (parentId) {
      edges.push({
        id: `e-${parentId}-${nodeId}`,
        source: parentId,
        target: nodeId,
        type: "smoothstep",
        style: {
          stroke: color,
          strokeWidth: depth === 1 ? 2.5 : 1.5,
          opacity: 0.75,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 10,
          height: 10,
        },
      });
    }

    if (!hasChildren || !isExpanded) return;

    const totalW = children.reduce(
      (s, c, i) => s + subtreeWidth(c, `${nodeId}-${i}`, expandedIds),
      0
    );
    let cursor = centerX - totalW / 2;
    children.forEach((child, i) => {
      const childColor =
        depth === 0
          ? BRANCH_COLORS[(i % (BRANCH_COLORS.length - 1)) + 1]
          : color;
      const cw = subtreeWidth(child, `${nodeId}-${i}`, expandedIds);
      traverse(child, `${nodeId}-${i}`, nodeId, depth + 1, cursor + cw / 2, childColor);
      cursor += cw;
    });
  }

  traverse(root, "root", null, 0, 0, BRANCH_COLORS[0]);
  return { nodes, edges };
}

// ── Custom node ──────────────────────────────────────────────────────────────

function MindMapNodeComp({ data }: NodeProps<NodeData>) {
  const { label, depth, branchColor, hasChildren, isExpanded, onToggle } = data;

  const baseStyle: React.CSSProperties =
    depth === 0
      ? {
          background: "linear-gradient(135deg, #0972d3 0%, #0549a8 100%)",
          color: "#fff",
          borderRadius: 18,
          padding: "14px 28px",
          fontFamily: "var(--font-family-base)",
          fontWeight: "var(--font-weight-heading-xl)" as React.CSSProperties["fontWeight"],
          fontSize: "var(--font-size-heading-s)",
          letterSpacing: "var(--letter-spacing-heading-s)",
          lineHeight: "var(--line-height-heading-s)",
          boxShadow: "0 6px 24px rgba(9,114,211,0.45)",
          textAlign: "center",
          wordBreak: "break-word",
          maxWidth: 220,
        }
      : depth === 1
      ? {
          background: branchColor,
          color: "#fff",
          borderRadius: 12,
          padding: "9px 20px",
          fontFamily: "var(--font-family-base)",
          fontWeight: "var(--font-weight-bold)" as React.CSSProperties["fontWeight"],
          fontSize: "var(--font-size-body-m)",
          letterSpacing: "var(--letter-spacing-body-m)",
          lineHeight: "var(--line-height-body-m)",
          boxShadow: `0 4px 14px ${branchColor}60`,
          textAlign: "center",
          wordBreak: "break-word",
          maxWidth: 180,
        }
      : {
          background: "var(--color-background-container-content)",
          color: "var(--color-text-body-primary)",
          borderRadius: 8,
          padding: "7px 14px",
          fontFamily: "var(--font-family-base)",
          fontWeight: "var(--font-weight-normal)" as React.CSSProperties["fontWeight"],
          fontSize: "var(--font-size-body-s)",
          letterSpacing: "var(--letter-spacing-body-s)",
          lineHeight: "var(--line-height-body-s)",
          boxShadow: "var(--shadow-container)",
          border: `1.5px solid ${branchColor}55`,
          textAlign: "center",
          wordBreak: "break-word",
          maxWidth: 160,
        };

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        style={{ opacity: 0, pointerEvents: "none" }}
      />
      <div
        onClick={hasChildren ? onToggle : undefined}
        style={{
          position: "relative",
          cursor: hasChildren ? "pointer" : "default",
          userSelect: "none",
          ...baseStyle,
        }}
      >
        {label}
        {hasChildren && (
          <span
            style={{
              position: "absolute",
              top: -9,
              right: -9,
              width: 20,
              height: 20,
              background: isExpanded ? "#6c7686" : branchColor,
              color: "#fff",
              borderRadius: "50%",
              fontSize: 15,
              lineHeight: "20px",
              textAlign: "center",
              fontWeight: 700,
              boxShadow: "0 1px 5px rgba(0,0,0,0.25)",
              transition: "background 0.15s",
            }}
          >
            {isExpanded ? "−" : "+"}
          </span>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ opacity: 0, pointerEvents: "none" }}
      />
    </>
  );
}

const nodeTypes = { mindmap: MindMapNodeComp };

// ── Auto-fit helper (must live inside ReactFlow context) ─────────────────────

function AutoFit({ trigger }: { trigger: number }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      fitView({ padding: 0.18, duration: 400 })
    );
    return () => cancelAnimationFrame(id);
  }, [trigger]);
  return null;
}

// ── Main component ───────────────────────────────────────────────────────────

export default function MindMapViewer({ data }: Props) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        // Collapse this node and all descendants
        for (const eid of [...next]) {
          if (eid === id || eid.startsWith(`${id}-`)) next.delete(eid);
        }
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const { nodes: computedNodes, edges: computedEdges } = useMemo(
    () => buildGraph(data, expandedIds, toggle),
    [data, expandedIds, toggle]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(computedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(computedEdges);

  useEffect(() => {
    setNodes(computedNodes);
    setEdges(computedEdges);
  }, [computedNodes, computedEdges]);

  return (
    <div
      style={{
        height: "calc(100vh - 310px)",
        minHeight: 560,
        borderRadius: 12,
        overflow: "hidden",
        boxShadow: "0 1px 12px rgba(0,0,0,0.08)",
        border: "1px solid #e9ebed",
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.1}
        maxZoom={2.5}
      >
        <AutoFit trigger={nodes.length} />
        <Controls />
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.2}
          color="#d1d5db"
        />
        <MiniMap
          nodeColor={(n) =>
            (n.data as NodeData).branchColor ?? "#8d99a5"
          }
          maskColor="rgba(255,255,255,0.72)"
          style={{ bottom: 60 }}
        />
      </ReactFlow>
    </div>
  );
}
