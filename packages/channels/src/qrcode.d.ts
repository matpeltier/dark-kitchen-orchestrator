declare module 'qrcode' {
  export interface QrToStringOptions {
    readonly type?: 'terminal' | 'utf8' | 'svg' | 'text';
    readonly errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    readonly small?: boolean;
    readonly margin?: number;
    readonly width?: number;
  }

  export function toString(text: string, options?: QrToStringOptions): Promise<string>;
}
