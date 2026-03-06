import { create } from 'zustand';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

interface ConnectionState {
    status: ConnectionStatus;
    setStatus: (status: ConnectionStatus) => void;
}

export const useConnectionStore = create<ConnectionState>()((set) => ({
    status: 'connecting',
    setStatus: (status) => set({ status }),
}));

export const selectConnectionStatus = (s: ConnectionState) => s.status;
