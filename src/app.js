import { timingSafeEqual, createHash } from 'node:crypto';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { readFileSync } from 'node:fs';
import { BusyError, GrouperError } from './groupers.js';
import { InputError, toGrouperRecord } from './input.js';
import { DISCHARGE_TYPES, ERROR_CODES, WARNING_CODES, describeError, describeWarnings } from './codes.js';
import { DbfFormatError, groupDbf } from './dbffile.js';

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
const DBF_TYPES = ['application/octet-stream', 'application/x-dbase', 'application/x-dbf', 'application/dbf', 'application/vnd.dbf'];

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

function toResult(index, ref, version, pool, out, notes) {
    const drg = out.DRG || null;
    const err = out.ERR ?? 0;
    const warn = out.WARN ?? 0;
    const age = out.AGE === '' || out.AGE === undefined ? null : Number(out.AGE);
    const ageDay = out.AGEDAY === '' || out.AGEDAY === undefined ? null : Number(out.AGEDAY);
    return {
        index,
        ref: ref ?? null,
        ok: true,
        version,
        engine: pool.engine,
        drg,
        dc: out.DC ?? null,
        pcl: out.PCL ?? null,
        pdxUsed: out.PDXUSED ?? null,
        drgName: drg ? pool.drgTable.get(drg)?.name ?? null : null,
        mdc: out.MDC || null,
        rw: out.RW,
        adjrw: out.ADJRW,
        wtlos: out.WTLOS,
        ot: out.OT,
        los: out.ACTLOS,
        age: Number.isFinite(age) ? age : null,
        ageDay: Number.isFinite(ageDay) ? ageDay : null,
        errorCode: err,
        error: describeError(err),
        warningCode: warn,
        warnings: describeWarnings(warn),
        notes,
    };
}

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
        if (err instanceof DbfFormatError) {
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

    // The raw .dbf is the body: no multipart, so nothing is written to a temp file.
    await app.register(async (scope) => {
        scope.addContentTypeParser(DBF_TYPES, { parseAs: 'buffer' }, (req, body, done) => done(null, body));
        scope.post('/api/v1/group/file', {
            schema: {
                tags: ['grouper'],
                summary: 'Group a .dbf data file and get it back with the results',
                description: [
                    'Send the .dbf file that TGrp6305.exe used to read (the grouper layout: DOB, SEX, DATEADM, TIMEADM, DATEDSC, TIMEDSC, DISCHT, ADMWT, AGE, AGEDAY, PDX, SDX1-12, PROC1-20, LEAVEDAY) as the raw body, Content-Type application/octet-stream.',
                    'The answer is the same file with DRG, MDC, ERR, WARN, RW, ADJRW, WTLOS, OT and ACTLOS filled in. Every other byte stays as it was (other columns, Thai text, deleted records). Result fields the file does not have are added at the end of each record.',
                    `The fields are read as the exe reads them, without clean-up. At most ${config.maxFileRecords} records. A summary is in the X-Grouper-Summary header (JSON). The file is handled in memory only; it is not stored or logged.`,
                ].join('\n\n'),
                consumes: DBF_TYPES,
                querystring: { type: 'object', properties: { version: versionParam } },
                produces: ['application/octet-stream'],
            },
        }, async (req, reply) => {
            const pool = poolFor(req.query.version);
            if (!Buffer.isBuffer(req.body)) {
                return reply.code(415).send({ statusCode: 415, error: 'Unsupported Media Type', message: 'send the .dbf file as the body with Content-Type application/octet-stream' });
            }
            const { file, summary } = await groupDbf(req.body, (records) => runner.group(pool.version, records), { maxRecords: config.maxFileRecords });
            return reply
                .header('content-type', 'application/octet-stream')
                .header('content-disposition', 'attachment; filename="grouped.dbf"')
                .header('cache-control', 'no-store')
                .header('x-grouper-summary', JSON.stringify({ version: pool.version, ...summary }))
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
