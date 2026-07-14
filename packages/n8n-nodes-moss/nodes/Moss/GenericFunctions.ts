export const CLOUD_MANAGE_URL = 'https://service.usemoss.dev/v1/manage';
export const CLOUD_QUERY_URL = 'https://service.usemoss.dev/query';

export interface MossDocument {
	id: string;
	text: string;
	metadata?: Record<string, string>;
}

export interface MossCredentials {
	projectId: string;
	projectKey: string;
}

interface ManageResponse {
	[key: string]: unknown;
}

async function manageRequest(
	credentials: MossCredentials,
	body: Record<string, unknown>,
): Promise<ManageResponse> {
	const response = await fetch(CLOUD_MANAGE_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-project-key': credentials.projectKey,
			'x-service-version': 'v1',
		},
		body: JSON.stringify({
			projectId: credentials.projectId,
			...body,
		}),
	});

	const text = await response.text();
	let data: ManageResponse = {};
	if (text) {
		try {
			data = JSON.parse(text) as ManageResponse;
		} catch {
			throw new Error(`Moss API returned non-JSON response (${response.status}): ${text}`);
		}
	}

	if (!response.ok) {
		const message =
			typeof data.error === 'string'
				? data.error
				: `Moss API error ${response.status}`;
		throw new Error(message);
	}

	return data;
}

/**
 * Serializes docs into the Moss bulk upload binary format:
 *   [MOSS (4B)] [version=1 (4B)] [docCount (4B)] [dim (4B)]
 *   [metaLen (4B)] [metadata JSON] [float32 embeddings]
 */
export function serializeBulkPayload(docs: MossDocument[]): ArrayBuffer {
	const metadata = docs.map(({ id, text, metadata: meta }) => ({
		id,
		text,
		...(meta ? { metadata: meta } : {}),
	}));
	const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));

	const HEADER_SIZE = 20;
	const totalSize = HEADER_SIZE + metadataBytes.length;
	const buffer = new ArrayBuffer(totalSize);
	const view = new DataView(buffer);
	const byteView = new Uint8Array(buffer);

	byteView.set([0x4d, 0x4f, 0x53, 0x53], 0); // "MOSS"
	view.setUint32(4, 1, true); // bulk format version
	view.setUint32(8, docs.length, true);
	view.setUint32(12, 0, true); // dimension=0 → server embeds
	view.setUint32(16, metadataBytes.length, true);
	byteView.set(metadataBytes, HEADER_SIZE);

	return buffer;
}

async function uploadWithRetries(uploadUrl: string, payload: ArrayBuffer): Promise<void> {
	const MAX_UPLOAD_RETRIES = 3;
	let lastStatus = 0;

	for (let attempt = 0; attempt < MAX_UPLOAD_RETRIES; attempt++) {
		const response = await fetch(uploadUrl, {
			method: 'PUT',
			body: payload,
			headers: { 'Content-Type': 'application/octet-stream' },
		});
		lastStatus = response.status;
		if (response.ok) return;
		if (response.status < 500) break;
		if (attempt < MAX_UPLOAD_RETRIES - 1) {
			await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
		}
	}

	throw new Error(`Failed to upload Moss index payload (HTTP ${lastStatus})`);
}

async function pollJobUntilComplete(
	credentials: MossCredentials,
	jobId: string,
	indexName: string,
	docCount: number,
): Promise<Record<string, unknown>> {
	const POLL_INTERVAL_MS = 2000;
	const MAX_POLL_TIME_MS = 30 * 60 * 1000;
	const start = Date.now();

	while (Date.now() - start < MAX_POLL_TIME_MS) {
		const status = await manageRequest(credentials, {
			action: 'getJobStatus',
			jobId,
		});

		const jobStatus = String(status.status ?? '').toLowerCase();
		if (jobStatus === 'completed') {
			return { jobId, indexName, docCount, status: 'completed' };
		}
		if (jobStatus === 'failed') {
			throw new Error(`Moss job failed: ${String(status.error ?? 'unknown error')}`);
		}

		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}

	throw new Error(`Moss job timed out after ${MAX_POLL_TIME_MS / 1000}s (job ${jobId})`);
}

export async function createIndex(
	credentials: MossCredentials,
	indexName: string,
	docs: MossDocument[],
	modelId: string,
): Promise<Record<string, unknown>> {
	if (!docs.length) {
		throw new Error('Create Index requires at least one document');
	}

	const init = await manageRequest(credentials, {
		action: 'initUpload',
		indexName,
		modelId,
		docCount: docs.length,
		dimension: 0,
	});

	const jobId = String(init.jobId ?? '');
	const uploadUrl = String(init.uploadUrl ?? '');
	if (!jobId || !uploadUrl) {
		throw new Error('Moss initUpload did not return jobId/uploadUrl');
	}

	await uploadWithRetries(uploadUrl, serializeBulkPayload(docs));

	await manageRequest(credentials, {
		action: 'startBuild',
		jobId,
	});

	return pollJobUntilComplete(credentials, jobId, indexName, docs.length);
}

export async function addDocs(
	credentials: MossCredentials,
	indexName: string,
	docs: MossDocument[],
	upsert: boolean,
): Promise<Record<string, unknown>> {
	if (!docs.length) {
		throw new Error('Add Documents requires at least one document');
	}

	return manageRequest(credentials, {
		action: 'addDocs',
		indexName,
		docs,
		options: { upsert },
	});
}

export async function deleteDocs(
	credentials: MossCredentials,
	indexName: string,
	docIds: string[],
): Promise<Record<string, unknown>> {
	if (!docIds.length) {
		throw new Error('Delete Documents requires at least one document ID');
	}

	return manageRequest(credentials, {
		action: 'deleteDocs',
		indexName,
		docIds,
	});
}

export async function getDocs(
	credentials: MossCredentials,
	indexName: string,
	docIds?: string[],
): Promise<unknown> {
	return manageRequest(credentials, {
		action: 'getDocs',
		indexName,
		...(docIds?.length ? { docIds } : {}),
	});
}

export async function listIndexes(credentials: MossCredentials): Promise<unknown> {
	return manageRequest(credentials, { action: 'listIndexes' });
}

export async function getIndex(
	credentials: MossCredentials,
	indexName: string,
): Promise<Record<string, unknown>> {
	return manageRequest(credentials, { action: 'getIndex', indexName });
}

export async function deleteIndex(
	credentials: MossCredentials,
	indexName: string,
): Promise<Record<string, unknown>> {
	return manageRequest(credentials, { action: 'deleteIndex', indexName });
}

export async function getJobStatus(
	credentials: MossCredentials,
	jobId: string,
): Promise<Record<string, unknown>> {
	return manageRequest(credentials, { action: 'getJobStatus', jobId });
}

export async function queryIndex(
	credentials: MossCredentials,
	indexName: string,
	query: string,
	topK: number,
): Promise<Record<string, unknown>> {
	const response = await fetch(CLOUD_QUERY_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			query,
			indexName,
			projectId: credentials.projectId,
			projectKey: credentials.projectKey,
			topK,
		}),
	});

	const text = await response.text();
	let data: Record<string, unknown> = {};
	if (text) {
		try {
			data = JSON.parse(text) as Record<string, unknown>;
		} catch {
			throw new Error(`Moss query returned non-JSON response (${response.status}): ${text}`);
		}
	}

	if (!response.ok) {
		const message =
			typeof data.error === 'string' ? data.error : `Moss query error ${response.status}`;
		throw new Error(message);
	}

	return data;
}
