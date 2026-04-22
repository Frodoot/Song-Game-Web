export interface IShellOptions {
    silent: boolean;
    async: boolean;
}
export default function whisperShell(command: string, options?: IShellOptions): Promise<any>;
