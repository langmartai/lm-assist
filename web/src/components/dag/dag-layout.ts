// DAG Layout — pure function, no React dependency
// Portable: uses only dag-types.ts

import type { DagGraph, DagLayoutResult, DagLayoutOptions, LayoutNode, LayoutEdge } from './dag-types';

const DEFAULTS = {
  nodeW: 200,
  nodeH: 64,
  layerGap: 120,
  nodeGap: 20,
  direction: 'LR' as const,
};

/**
 * Compute positioned layout for a DAG using topological sort + BFS layering.
 * Features:
 * - Adaptive node sizing for large graphs
 * - Grid wrapping for wide layers (many children)
 * - Serpentine wrapping for deep chains (many layers)
 * - Handles disconnected components and cycles
 */
export function computeDagLayout(
  graph: DagGraph,
  options?: DagLayoutOptions,
): DagLayoutResult {
  const opts = { ...DEFAULTS, ...options };

  if (graph.nodes.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0, nodeW: opts.nodeW, nodeH: opts.nodeH };
  }

  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));

  // Build adjacency and in-degree
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of graph.edges) {
    if (nodeMap.has(e.from) && nodeMap.has(e.to)) {
      adj.get(e.from)!.push(e.to);
      inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
    }
  }

  // BFS layering (topological sort)
  const layers: string[][] = [];
  const visited = new Set<string>();
  let queue = graph.nodes
    .filter(n => (inDegree.get(n.id) || 0) === 0)
    .map(n => n.id);

  while (queue.length > 0) {
    layers.push([...queue]);
    queue.forEach(id => visited.add(id));
    const next: string[] = [];
    for (const id of queue) {
      for (const child of adj.get(id) || []) {
        if (!visited.has(child)) {
          const remaining = (inDegree.get(child) || 0) - 1;
          inDegree.set(child, remaining);
          if (remaining <= 0 && !next.includes(child)) {
            next.push(child);
          }
        }
      }
    }
    queue = next;
  }

  // Handle cycles/disconnected nodes
  const unvisited = graph.nodes.filter(n => !visited.has(n.id)).map(n => n.id);
  if (unvisited.length > 0) layers.push(unvisited);

  const totalNodes = graph.nodes.length;
  const numLayers = layers.length;
  const maxLayerSize = Math.max(1, ...layers.map(l => l.length));

  // === Adaptive sizing based on node count ===
  let { nodeW, nodeH, layerGap, nodeGap, direction } = opts;
  if (totalNodes > 30) {
    const scale = Math.max(0.35, Math.min(1, 1.2 - totalNodes / 200));
    nodeW = Math.max(80, Math.round(opts.nodeW * scale));
    nodeH = Math.max(28, Math.round(opts.nodeH * scale));
    layerGap = Math.max(40, Math.round(opts.layerGap * scale));
    nodeGap = Math.max(8, Math.round(opts.nodeGap * scale));
  }

  const isLR = direction === 'LR';
  const mainDim = isLR ? nodeW : nodeH;
  const crossDim = isLR ? nodeH : nodeW;
  const padding = 20;

  // === Grid wrapping for wide layers ===
  // When a single layer has many nodes, split into sub-columns to fill 2D space
  const maxPerRow = maxLayerSize <= 6 ? maxLayerSize : Math.max(4, Math.ceil(Math.sqrt(maxLayerSize * 1.5)));

  // Compute each layer's grid dimensions
  const layerGrid = layers.map(layer => {
    if (layer.length <= maxPerRow) return { subCols: 1, rows: layer.length };
    const subCols = Math.ceil(layer.length / maxPerRow);
    return { subCols, rows: Math.min(layer.length, maxPerRow) };
  });

  // Cumulative main-axis start positions (accounting for sub-columns)
  const layerMainStart: number[] = [padding];
  for (let i = 1; i < numLayers; i++) {
    const prev = layerGrid[i - 1];
    const prevExtent = prev.subCols * mainDim + (prev.subCols - 1) * nodeGap;
    layerMainStart.push(layerMainStart[i - 1] + prevExtent + layerGap);
  }

  // Check if we need serpentine wrapping
  const lastGrid = layerGrid[numLayers - 1];
  const lastExtent = lastGrid.subCols * mainDim + (lastGrid.subCols - 1) * nodeGap;
  const totalMainDim = layerMainStart[numLayers - 1] + lastExtent + padding;
  const maxCrossPerLayer = Math.max(1, ...layerGrid.map(g => g.rows));
  const totalCrossDim = maxCrossPerLayer * (crossDim + nodeGap);

  // === Serpentine wrapping for deep/long graphs ===
  let maxCols = numLayers;
  let useSerpentine = false;

  if (numLayers > 6 && totalMainDim > totalCrossDim * 2.5) {
    useSerpentine = true;
    // Find ideal column count for ~1.6:1 aspect ratio
    const targetRatio = 1.6;
    let bestCols = numLayers;
    let bestDiff = Infinity;
    for (let cols = 3; cols <= Math.min(numLayers, 40); cols++) {
      const numBands = Math.ceil(numLayers / cols);
      const estW = cols * (mainDim + layerGap);
      const estH = numBands * (totalCrossDim + layerGap);
      const diff = Math.abs(estW / Math.max(1, estH) - targetRatio);
      if (diff < bestDiff) { bestDiff = diff; bestCols = cols; }
    }
    maxCols = bestCols;
  }

  // === Position nodes ===
  const nodePositions: LayoutNode[] = [];

  if (!useSerpentine) {
    // Standard layout with grid wrapping for wide layers
    const globalMaxCross = maxCrossPerLayer * (crossDim + nodeGap) - nodeGap;

    for (let li = 0; li < numLayers; li++) {
      const layer = layers[li];
      const grid = layerGrid[li];
      const mainStart = layerMainStart[li];

      // Center this layer's rows within the global cross-axis space
      const layerCrossSize = grid.rows * crossDim + (grid.rows - 1) * nodeGap;
      const crossStart = padding + Math.max(0, (globalMaxCross - layerCrossSize) / 2);

      for (let ni = 0; ni < layer.length; ni++) {
        const node = nodeMap.get(layer[ni]);
        if (!node) continue;

        const subCol = Math.floor(ni / maxPerRow);
        const row = ni % maxPerRow;

        const mainPos = mainStart + subCol * (mainDim + nodeGap);
        const crossPos = crossStart + row * (crossDim + nodeGap);

        nodePositions.push({
          id: node.id,
          x: isLR ? mainPos : crossPos,
          y: isLR ? crossPos : mainPos,
          node,
        });
      }
    }
  } else {
    // Serpentine: wrap layers into horizontal bands
    const numBands = Math.ceil(numLayers / maxCols);

    // Max cross-axis nodes per band
    const bandMaxRows: number[] = [];
    for (let band = 0; band < numBands; band++) {
      let maxRows = 0;
      for (let li = band * maxCols; li < Math.min((band + 1) * maxCols, numLayers); li++) {
        maxRows = Math.max(maxRows, layers[li].length);
      }
      bandMaxRows.push(maxRows);
    }

    // Cross-axis offsets for each band
    const bandCrossStart: number[] = [padding];
    for (let band = 1; band < numBands; band++) {
      const prevH = bandMaxRows[band - 1] * (crossDim + nodeGap);
      bandCrossStart.push(bandCrossStart[band - 1] + prevH + layerGap * 0.7);
    }

    for (let li = 0; li < numLayers; li++) {
      const layer = layers[li];
      const band = Math.floor(li / maxCols);
      const colInBand = li % maxCols;

      const mainPos = padding + colInBand * (mainDim + layerGap);

      // Center layer nodes within band's cross-axis space
      const bandCross = bandMaxRows[band] * (crossDim + nodeGap) - nodeGap;
      const layerCross = layer.length * (crossDim + nodeGap) - nodeGap;
      const crossStart = bandCrossStart[band] + Math.max(0, (bandCross - layerCross) / 2);

      for (let ni = 0; ni < layer.length; ni++) {
        const node = nodeMap.get(layer[ni]);
        if (!node) continue;

        const crossPos = crossStart + ni * (crossDim + nodeGap);

        nodePositions.push({
          id: node.id,
          x: isLR ? mainPos : crossPos,
          y: isLR ? crossPos : mainPos,
          node,
        });
      }
    }
  }

  // === Build edge coordinates ===
  const posMap = new Map(nodePositions.map(n => [n.id, n]));
  const edgeList: LayoutEdge[] = [];

  for (const e of graph.edges) {
    const fromNode = posMap.get(e.from);
    const toNode = posMap.get(e.to);
    if (!fromNode || !toNode) continue;

    if (isLR) {
      const fromRight = fromNode.x + nodeW;
      const toLeft = toNode.x;
      if (toLeft >= fromRight - nodeW * 0.3) {
        // Forward: right side → left side
        edgeList.push({
          from: { x: fromRight, y: fromNode.y + nodeH / 2 },
          to: { x: toLeft, y: toNode.y + nodeH / 2 },
          fromId: e.from, toId: e.to, type: e.type,
        });
      } else {
        // Cross-band / backward: bottom → top
        edgeList.push({
          from: { x: fromNode.x + nodeW / 2, y: fromNode.y + nodeH },
          to: { x: toNode.x + nodeW / 2, y: toNode.y },
          fromId: e.from, toId: e.to, type: e.type,
        });
      }
    } else {
      const fromBottom = fromNode.y + nodeH;
      const toTop = toNode.y;
      if (toTop >= fromBottom - nodeH * 0.3) {
        edgeList.push({
          from: { x: fromNode.x + nodeW / 2, y: fromBottom },
          to: { x: toNode.x + nodeW / 2, y: toTop },
          fromId: e.from, toId: e.to, type: e.type,
        });
      } else {
        edgeList.push({
          from: { x: fromNode.x + nodeW, y: fromNode.y + nodeH / 2 },
          to: { x: toNode.x, y: toNode.y + nodeH / 2 },
          fromId: e.from, toId: e.to, type: e.type,
        });
      }
    }
  }

  // Compute total dimensions
  let graphW = 0, graphH = 0;
  for (const n of nodePositions) {
    graphW = Math.max(graphW, n.x + nodeW + padding);
    graphH = Math.max(graphH, n.y + nodeH + padding);
  }

  return {
    nodes: nodePositions,
    edges: edgeList,
    width: Math.max(graphW, 300),
    height: Math.max(graphH, 200),
    nodeW,
    nodeH,
  };
}
