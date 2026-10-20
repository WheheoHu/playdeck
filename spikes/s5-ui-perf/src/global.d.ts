interface PlayDeckConfig {
  baseUrl: string;
  token: string;
  refreshHz: number | null;
}

type HarnessMessage = { type: 'start' } | { type: 'phase'; phase: string } | { type: 'stop' };

interface Window {
  playdeck: {
    getConfig(): Promise<PlayDeckConfig>;
    ready(): void;
    onHarness(callback: (message: HarnessMessage) => void): void;
    reportResult(result: unknown): void;
  };
}
