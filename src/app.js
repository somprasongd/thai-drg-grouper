import { timingSafeEqual, createHash } from 'node:crypto';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { readFileSync } from 'node:fs';
import { BusyError, GrouperError } from './groupers.js';
import { InputError, toGrouperRecord } from './input.js';
import { DISCHARGE_TYPES, ERROR_CODES, WARNING_CODES } from './codes.js';
import { toResult } from './result.js';
import { DbfFormatError } from './dbffile.js';
import { FileFormatError, groupFile } from './files.js';
import { ZipError } from './zip.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// The web UI: a few static files, read once. Only these names are served.
const WEB_FILES = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/ui/app.css': ['app.css', 'text/css; charset=utf-8'],
    '/ui/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/ui/icon.svg': ['icon.svg', 'image/svg+xml'],
};
const WEB_HEADERS = {
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
};

// ---------- JSON schemas (also used for the OpenAPI page at /docs) ----------

const strOrNum = { anyOf: [{ type: 'string' }, { type: 'number' }] };

const caseSchema = {
    $id: 'case',
    type: 'object',
    additionalProperties: false,
    properties: {
        ref: { type: 'string', maxLength: 100, description: 'Your own id for the case (e.g. AN or visit id). Sent back unchanged.' },
        sex: { ...strOrNum, description: '1 = male, 2 = female (M/F also accepted)' },
        dob: { type: 'string', description: 'Date of birth, YYYY-MM-DD (Christian era)' },
        admitDate: { type: 'string', description: 'Admission date, YYYY-MM-DD, or YYYY-MM-DDTHH:mm' },
        admitTime: { type: 'string', description: 'Admission time HH:mm (if not in admitDate)' },
        dischargeDate: { type: 'string', description: 'Discharge date, YYYY-MM-DD, or YYYY-MM-DDTHH:mm' },
        dischargeTime: { type: 'string', description: 'Discharge time HH:mm (if not in dischargeDate)' },
        dischargeType: { ...strOrNum, description: '1 approval, 2 against advice, 3 escape, 4 transfer, 5 other, 8/9 dead' },
        admitWeight: { ...strOrNum, description: 'Weight at admission in kg; needed when age < 28 days' },
        age: { ...strOrNum, description: 'Age in whole years at admission. Worked out from dob when left out.' },
        ageDay: { ...strOrNum, description: 'Days since the last birthday at admission. Worked out from dob when left out.' },
        pdx: { type: 'string', description: 'Principal diagnosis, ICD-10 (dots allowed)' },
        sdx: {
            anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
            description: 'Secondary diagnoses, ICD-10, at most 12 are used',
        },
        procedures: {
            anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
            description: 'Procedures, ICD-9-CM (dots allowed, extension allowed), at most 20 are used',
        },
        leaveDays: { ...strOrNum, description: 'Days on leave (subtracted from LOS). Default 0.' },
    },
};

const resultSchema = {
    $id: 'result',
    type: 'object',
    properties: {
        index: { type: 'integer' },
        ref: { type: ['string', 'null'] },
        ok: { type: 'boolean', description: 'false when the input could not be grouped (see inputErrors)' },
        version: { type: 'string' },
        engine: { type: 'string', description: 'always native' },
        drg: { type: ['string', 'null'] },
        dc: { type: ['string', 'null'], description: 'Disease cluster' },
        pcl: { type: ['integer', 'null'], description: 'Patient clinical complexity level used for the DRG' },
        pdxUsed: { type: ['string', 'null'], description: 'PDx after reassignment' },
        drgName: { type: ['string', 'null'] },
        mdc: { type: ['string', 'null'] },
        rw: { type: ['number', 'null'] },
        adjrw: { type: ['number', 'null'] },
        wtlos: { type: ['number', 'null'] },
        ot: { type: ['number', 'null'] },
        los: { type: ['number', 'null'], description: 'Length of stay worked out by the grouper (ACTLOS)' },
        age: { type: ['number', 'null'] },
        ageDay: { type: ['number', 'null'] },
        errorCode: { type: 'integer' },
        error: {
            type: ['object', 'null'],
            properties: { code: { type: 'integer' }, message: { type: 'string' } },
        },
        warningCode: { type: 'integer' },
        warnings: {
            type: 'array',
            items: { type: 'object', properties: { code: { type: 'integer' }, message: { type: 'string' } } },
        },
        notes: { type: 'array', items: { type: 'string' }, description: 'What the API changed in the input (cut codes, extra codes dropped)' },
        inputErrors: { type: 'array', items: { type: 'string' } },
    },
};

const errorSchema = {
    $id: 'apiError',
    type: 'object',
    properties: {
        statusCode: { type: 'integer' },
        error: { type: 'string' },
        message: { type: 'string' },
        problems: { type: 'array', items: { type: 'string' } },
    },
};

// ---------- helpers ----------

function sameSecret(a, b) {
    const ha = createHash('sha256').update(a).digest();
    const hb = createHash('sha256').update(b).digest();
    return timingSafeEqual(ha, hb);
}

// ---------- app ----------

/**
 * @param {object} config from loadConfig()
 * @param {import('./groupers.js').GrouperSet} runner
 */
export async function buildApp(config, runner, fastifyOptions = {}) {
    const pools = runner.versions;
    const app = Fastify({
        logger: { level: config.logLevel },
        bodyLimit: 50 * 1024 * 1024,
        ...fastifyOptions,
    });

    app.addSchema(caseSchema);
    app.addSchema(resultSchema);
    app.addSchema(errorSchema);

    await app.register(swagger, {
        openapi: {
            info: {
                title: 'Thai DRG Grouper API',
                version: pkg.version,
                description: 'REST API for Thai DRG grouping. The grouping logic is written in JavaScript from the TCMC Thai DRG 6.3.3 books and runs on the TCMC 6.3.4 tables. Results are checked against TGrp6305.exe.',
            },
            components: config.apiKey
                ? { securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } }
                : {},
            security: config.apiKey ? [{ apiKey: [] }] : [],
        },
        refResolver: { buildLocalReference: (json) => json.$id },
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });

    if (config.apiKey) {
        app.addHook('onRequest', async (req, reply) => {
            if (!req.url.startsWith('/api/')) return;
            const given = req.headers['x-api-key'];
            if (typeof given !== 'string' || !sameSecret(given, config.apiKey)) {
                reply.code(401).send({ statusCode: 401, error: 'Unauthorized', message: 'missing or wrong X-API-Key header' });
            }
        });
    }

    app.setErrorHandler((err, req, reply) => {
        if (err.validation) {
            return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: err.message });
        }
        if (err instanceof DbfFormatError || err instanceof FileFormatError || err instanceof ZipError) {
            return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: err.message });
        }
        if (err instanceof InputError) {
            return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'invalid case', problems: err.problems });
        }
        if (err instanceof BusyError) {
            return reply.code(503).header('Retry-After', '5').send({ statusCode: 503, error: 'Service Unavailable', message: err.message });
        }
        if (err instanceof GrouperError) {
            req.log.error({ err }, 'grouper failed');
            return reply.code(502).send({ statusCode: 502, error: 'Bad Gateway', message: err.message });
        }
        if (err.statusCode && err.statusCode < 500) {
            return reply.code(err.statusCode).send({ statusCode: err.statusCode, error: err.name, message: err.message });
        }
        req.log.error({ err }, 'unexpected error');
        return reply.code(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'unexpected error, see the server log' });
    });

    function poolFor(version) {
        const v = version || config.defaultVersion;
        const pool = pools.get(v);
        if (!pool) {
            const e = new Error(`unknown version "${v}", use one of: ${[...pools.keys()].join(', ')}`);
            e.statusCode = 400;
            throw e;
        }
        return pool;
    }

    const versionParam = { type: 'string', description: `Grouper version; default ${config.defaultVersion}` };

    app.get('/health', {
        schema: { tags: ['system'], summary: 'Liveness check and pool status' },
    }, async () => ({
        status: 'ok',
        defaultVersion: config.defaultVersion,
        queued: runner.queued,
        groupers: [...pools.values()].map((p) => ({
            version: p.version,
            engine: p.engine,
            runs: p.stats.runs,
            cases: p.stats.cases,
            failures: p.stats.failures,
            avgMsPerRun: p.stats.runs ? Math.round(p.stats.totalMs / p.stats.runs) : null,
        })),
    }));

    app.get('/api/v1/versions', {
        schema: { tags: ['reference'], summary: 'Grouper versions this server can run' },
    }, async () => ({
        default: config.defaultVersion,
        versions: [...pools.values()].map((p) => ({ version: p.version, engine: p.engine, name: p.name, drgCount: p.drgTable.size })),
    }));

    app.get('/api/v1/codes', {
        schema: { tags: ['reference'], summary: 'Error, warning and discharge-type codes' },
    }, async () => ({ errors: ERROR_CODES, warnings: WARNING_CODES, dischargeTypes: DISCHARGE_TYPES }));

    app.get('/api/v1/drg/:code', {
        schema: {
            tags: ['reference'],
            summary: 'Look up a DRG: name, RW, WtLOS, OT',
            params: { type: 'object', properties: { code: { type: 'string', pattern: '^[0-9A-Za-z]{5}$' } } },
            querystring: { type: 'object', properties: { version: versionParam } },
        },
    }, async (req, reply) => {
        const pool = poolFor(req.query.version);
        const row = pool.drgTable.get(req.params.code.toUpperCase());
        if (!row) return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `DRG ${req.params.code} is not in version ${pool.version}` });
        return { version: pool.version, ...row };
    });

    app.post('/api/v1/group', {
        schema: {
            tags: ['grouper'],
            summary: 'Group one case',
            querystring: { type: 'object', properties: { version: versionParam } },
            body: { $ref: 'case#' },
            response: { 200: { $ref: 'result#' }, 400: { $ref: 'apiError#' } },
        },
    }, async (req) => {
        const pool = poolFor(req.query.version);
        const { record, notes } = toGrouperRecord(req.body);
        const [out] = await runner.group(pool.version, [record]);
        return toResult(0, req.body.ref, pool.version, pool, out, notes);
    });

    app.post('/api/v1/group/batch', {
        schema: {
            tags: ['grouper'],
            summary: 'Group many cases in one request',
            description: 'Cases with bad input are not grouped: they come back with ok=false and inputErrors. Results keep the order of the request.',
            querystring: { type: 'object', properties: { version: versionParam } },
            body: {
                type: 'object',
                required: ['cases'],
                additionalProperties: false,
                properties: {
                    version: versionParam,
                    cases: { type: 'array', minItems: 1, maxItems: config.maxBatch, items: { $ref: 'case#' } },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        version: { type: 'string' },
                        count: { type: 'integer' },
                        grouped: { type: 'integer' },
                        rejected: { type: 'integer' },
                        results: { type: 'array', items: { $ref: 'result#' } },
                    },
                },
                400: { $ref: 'apiError#' },
            },
        },
    }, async (req) => {
        const pool = poolFor(req.body.version || req.query.version);
        const { cases } = req.body;
        const results = new Array(cases.length);
        const toRun = [];
        cases.forEach((c, index) => {
            try {
                const { record, notes } = toGrouperRecord(c);
                toRun.push({ index, ref: c.ref, record, notes });
            } catch (e) {
                if (!(e instanceof InputError)) throw e;
                results[index] = {
                    index, ref: c.ref ?? null, ok: false, version: pool.version,
                    errorCode: 0, error: null, warningCode: 0, warnings: [], notes: [], inputErrors: e.problems,
                };
            }
        });
        if (toRun.length) {
            const out = await runner.group(pool.version, toRun.map((t) => t.record));
            toRun.forEach((t, i) => {
                results[t.index] = toResult(t.index, t.ref, pool.version, pool, out[i], t.notes);
            });
        }
        return {
            version: pool.version,
            count: cases.length,
            grouped: toRun.length,
            rejected: cases.length - toRun.length,
            results,
        };
    });

    // The raw file is the body: no multipart, so nothing is written to a temp file.
    // Any Content-Type is taken; the kind of file is told from its bytes.
    await app.register(async (scope) => {
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => done(null, body));
        scope.post('/api/v1/group/file', {
            schema: {
                tags: ['grouper'],
                summary: 'Group a .dbf, .csv, .xlsx or .json file and get it back with the results',
                description: [
                    'Send the file as the raw body (any Content-Type, for example application/octet-stream). The kind of file is told from its bytes.',
                    '**.dbf**: the file that TGrp6305.exe used to read (DOB, SEX, DATEADM, TIMEADM, DATEDSC, TIMEDSC, DISCHT, ADMWT, AGE, AGEDAY, PDX, SDX1-12, PROC1-20, LEAVEDAY). The answer is the same file with DRG, MDC, ERR, WARN, RW, ADJRW, WTLOS, OT and ACTLOS filled in; every other byte stays as it was. The fields are read as the exe reads them, without clean-up.',
                    '**.csv / .xlsx**: a header row (within the first 20 rows) with a PDX column; the other columns use the API names (sex, dob, admitDate, …) or the .dbf names. SDX and procedure lists can be one column (split on , ; or space) or SDX1…, PROC1… columns. Dates as YYYY-MM-DD or DD/MM/YYYY, years in the Buddhist era are taken as such. The answer is the same file with DRG, DRGNAME, MDC, RW, ADJRW, WTLOS, OT, ACTLOS, ERR, ERRMSG, WARN, WARNMSG and GRPNOTE columns (written over when the file has them). A .csv can be UTF-8 or Windows-874 (TIS-620); the first sheet of an .xlsx with a PDX column is used. Old .xls files are not read.',
                    '**.json**: an array of cases, or an object with a `cases` array, as /api/v1/group/batch takes. Each case gets a `result`.',
                    `At most ${config.maxFileRecords} records. A summary is in the X-Grouper-Summary header (JSON). The file is handled in memory only; it is not stored or logged.`,
                ].join('\n\n'),
                querystring: { type: 'object', properties: { version: versionParam } },
                produces: ['application/octet-stream', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/json'],
            },
        }, async (req, reply) => {
            const pool = poolFor(req.query.version);
            if (!Buffer.isBuffer(req.body) || !req.body.length) {
                return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'send the .dbf, .csv, .xlsx or .json file as the request body' });
            }
            const { format, file, summary, contentType, ext } = await groupFile(req.body, {
                group: (records) => runner.group(pool.version, records),
                pool,
                maxRecords: config.maxFileRecords,
            });
            return reply
                .header('content-type', contentType)
                .header('content-disposition', `attachment; filename="grouped.${ext}"`)
                .header('cache-control', 'no-store')
                .header('x-grouper-summary', JSON.stringify({ version: pool.version, format, ...summary }))
                .send(file);
        });
    });

    if (config.webUi !== false) {
        const dir = new URL('./web/', import.meta.url);
        for (const [path, [name, type]] of Object.entries(WEB_FILES)) {
            const body = readFileSync(new URL(name, dir));
            app.get(path, { schema: { hide: true } }, async (req, reply) => reply.headers(WEB_HEADERS).type(type).header('cache-control', 'no-cache').send(body));
        }
    }

    return app;
}
