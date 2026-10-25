import type { PamphletViewerConfig } from "@/lib/public-api";

type ConfigListener = (config: PamphletViewerConfig) => void;

interface ConfigRecord {
	config: PamphletViewerConfig;
	listeners: Set<ConfigListener>;
}

const CONFIG_RECORDS = new WeakMap<object, ConfigRecord>();

export function setViewerElementConfig(host: object, config: PamphletViewerConfig): void {
	const record = getConfigRecord(host);
	record.config = config;
	for (const listener of record.listeners) listener(config);
}

export function subscribeViewerElementConfig(host: object, listener: ConfigListener): () => void {
	const record = getConfigRecord(host);
	record.listeners.add(listener);
	listener(record.config);
	return () => {
		record.listeners.delete(listener);
	};
}

function getConfigRecord(host: object): ConfigRecord {
	let record = CONFIG_RECORDS.get(host);
	if (record === undefined) {
		record = { config: {}, listeners: new Set() };
		CONFIG_RECORDS.set(host, record);
	}
	return record;
}
