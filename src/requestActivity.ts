/** Keep resets from racing with requests that can still change the scene. */
export class RequestActivity {
  private counts = new Map<number, number>();
  isActive(userId: number): boolean { return (this.counts.get(userId) ?? 0) > 0; }
  begin(userId: number): () => void {
    this.counts.set(userId, (this.counts.get(userId) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const remaining = (this.counts.get(userId) ?? 1) - 1;
      if (remaining) this.counts.set(userId, remaining);
      else this.counts.delete(userId);
    };
  }
}
