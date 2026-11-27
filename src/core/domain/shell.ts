export function quote(value: string): string {
  return /^[\w@:./=-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}
