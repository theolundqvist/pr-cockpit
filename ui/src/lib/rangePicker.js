export function moveRangeCursor(activeIdx, delta, fixedCount, total, dragStart, extend) {
  const nextStart = extend && dragStart === null && activeIdx >= fixedCount
    ? activeIdx - fixedCount
    : dragStart;
  const minimum = nextStart === null ? 0 : fixedCount;
  const nextIdx = Math.max(minimum, Math.min(total - 1, activeIdx + delta));
  return {
    activeIdx: nextIdx,
    dragStart: nextStart,
    dragEnd: nextStart === null ? null : nextIdx - fixedCount,
  };
}
