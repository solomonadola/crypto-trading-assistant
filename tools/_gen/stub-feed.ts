// Replay stub: scanLiveMarketEntries never calls these (only deploySignalToAutomatedFeed does).
export async function fetchAutomatedTrades(): Promise<any[]> { throw new Error('stub'); }
export async function executeSimulatedTrade(_t: any): Promise<boolean> { throw new Error('stub'); }
