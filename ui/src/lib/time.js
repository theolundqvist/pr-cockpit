export function relativeTime(iso) {
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return "now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)}d`;
  const months = days / 30;
  if (months < 12) return `${Math.floor(months)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function durationText(startedAt, endedAt) {
  const minutes = Math.round((new Date(endedAt) - new Date(startedAt)) / 60000);
  return minutes < 1 ? "<1m" : `${minutes}m`;
}
