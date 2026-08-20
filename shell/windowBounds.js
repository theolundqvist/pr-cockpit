function windowBoundsForPersistence(bounds, rememberSize, rememberPosition) {
  const saved = {};
  if (rememberPosition) {
    saved.x = bounds.x;
    saved.y = bounds.y;
  }
  if (rememberSize) {
    saved.width = bounds.width;
    saved.height = bounds.height;
  }
  return saved;
}

function windowBoundsForRestore(current, saved, rememberSize, rememberPosition) {
  const width = rememberSize && Number.isFinite(saved?.width) ? saved.width : current.width;
  const height = rememberSize && Number.isFinite(saved?.height) ? saved.height : current.height;
  const useSavedX = rememberPosition && Number.isFinite(saved?.x);
  const useSavedY = rememberPosition && Number.isFinite(saved?.y);
  return {
    x: useSavedX ? saved.x : Math.round(current.x + (current.width - width) / 2),
    y: useSavedY ? saved.y : Math.round(current.y + (current.height - height) / 2),
    width,
    height,
  };
}

module.exports = { windowBoundsForPersistence, windowBoundsForRestore };
