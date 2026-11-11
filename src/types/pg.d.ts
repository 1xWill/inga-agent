declare module 'pg' {
  export class Pool {
    constructor(config?: any);
    query(text: string, params?: any[]): Promise<{ rows: any[] }>;
    connect(): Promise<any>;
    end(): Promise<void>;
    on(event: string, listener: (...args: any[]) => void): void;
  }
}
