import { Quantity, QueryWriter, RecordRelation, ReturnMode, Schema, SchemaFields, Where } from "./types";
import { CirqlWriterError } from "../errors";
import { parseWhereClause } from "./parser";
import { assertRecordLink, getRelationFrom, getRelationTo, isListLike, thing, useSurrealValueUnsafe } from "../helpers";
import { eq } from "../sql/operators";
import { SurrealValue } from "../types";
import { z, ZodRawShape, ZodTypeAny } from "zod";

interface DeleteQueryState<S extends Schema, Q extends Quantity> {
	schema: S;
	quantity: Q;
	targets: string;
	where: string | undefined;
	returnMode: ReturnMode | 'fields' | undefined;
	returnFields: string[];
	timeout: number | undefined;
	parallel: boolean;
	unrelate: boolean;
}

/**
 * The query writer implementations for DELETE queries.
 * 
 * When prevention of SQL injections is important, avoid passing
 * variables to all functions except `where`.
 * 
 * When using Cirql server side, never trust record ids directly
 * passed to the query writer. Always use the `deleteRecord` function
 * to ensure the record id has an intended table name.
 */
export class DeleteQueryWriter<S extends Schema, Q extends Quantity> implements QueryWriter<S, Q> {
	
	readonly #state: DeleteQueryState<S, Q>;

	constructor(state: DeleteQueryState<S, Q>) {
		this.#state = state;
	}

	get _schema() {
		return this.#state.schema;
	}

	get _quantity() {
		return this.#state.quantity;
	}

	get _state() {
		return Object.freeze({...this.#state});
	}

	/**
	 * Define the schema that should be used to
	 * validate the query result.
	 * 
	 * @param schema The schema to use
	 * @returns The query writer
	 */
	with<NS extends ZodTypeAny>(schema: NS) {
		return new DeleteQueryWriter({
			...this.#state,
			schema: schema
		});
	}

	/**
	 * Define the schema that should be used to
	 * validate the query result. This is short
	 * for `with(z.object(schema))`.
	 * 
	 * @param schema The schema to use
	 * @returns The query writer
	 */
	withSchema<T extends ZodRawShape>(schema: T) {
		return this.with(z.object(schema));
	}

	/**
	 * Define a schema which accepts any value,
	 * useful in situations where a specific schema
	 * isn't needed. This is short for `with(z.any())`.
	 * 
	 * @returns The query writer
	 */
	withAny() {
		return this.with(z.any());
	}

	/**
	 * Define the where clause for the query. All values will be escaped
	 * automatically. Use of `raw` is supported, as well as any operators
	 * wrapping the raw function.
	 * 
	 * @param where The where clause
	 * @returns The query writer
	 */
	where(where: string|Where<S>) {
		if (this.#state.unrelate) {
			throw new CirqlWriterError('Cannot use where clause with delRelation');
		}

		if (typeof where === 'object') {
			where = parseWhereClause(where);	
		}

		return new DeleteQueryWriter({
			...this.#state,
			where
		});
	}

	/**
	 * Define the return behavior for the query
	 * 
	 * @param value The return behavior
	 * @returns The query writer
	 */
	return(mode: ReturnMode) {
		return new DeleteQueryWriter({
			...this.#state,
			returnMode: mode
		});
	}
	
	/**
	 * Define the return behavior for the query
	 * 
	 * @param value The return behavior
	 * @returns The query writer
	 */
	returnFields(...fields: SchemaFields<S>[]) {
		return new DeleteQueryWriter({
			...this.#state,
			returnMode: 'fields',
			returnFields: fields
		});
	}

	/**
	 * Set the timeout for the query
	 * 
	 * @param seconds The timeout in seconds
	 * @returns The query writer
	 */
	timeout(timeout: number) {
		return new DeleteQueryWriter({
			...this.#state,
			timeout
		});
	}

	/**
	 * Run the query in parallel
	 * 
	 * @returns The query writer
	 */
	parallel() {
		return new DeleteQueryWriter({
			...this.#state,
			parallel: true
		});
	}

	toQuery(): string {
		const {
			targets,
			where,
			returnMode,
			returnFields,
			timeout,
			parallel
		} = this.#state;

		if (!targets) {
			throw new Error('No targets specified');
		}
		
		let builder = `DELETE ${targets}`;

		if (where) {
			builder += ` WHERE ${where}`;
		}

		if (returnMode === 'fields') {
			builder += ` RETURN ${returnFields.join(', ')}`;
		} else if(returnMode) {
			builder += ` RETURN ${returnMode.toUpperCase()}`;
		}

		if (timeout) {
			builder += ` TIMEOUT ${timeout}s`;
		}

		if (parallel) {
			builder += ' PARALLEL';
		}

		return builder;
	}

}

/**
 * Start a new DELETE query with the given targets. Since delete
 * is a reserved word in JavaScript, this function is named `del`.
 * 
 * If you only want to delete one record, use the `delRecord` function.
 * 
 * @param targets The targets to delete
 * @returns The query writer
 */
export function del(...targets: SurrealValue[]) {
	if (targets.length === 0) {
		throw new CirqlWriterError('At least one target must be specified');
	}

	if (isListLike(...targets)) {
		throw new CirqlWriterError('Multiple targets must be specified seperately');
	}

	return new DeleteQueryWriter({
		schema: null,
		quantity: 'many',
		targets: targets.map(value => useSurrealValueUnsafe(value)).join(', '),
		where: undefined,
		returnMode: 'before',
		returnFields: [],
		timeout: undefined,
		parallel: false,
		unrelate: false
	});
}

/**
 * Start a new DELETE query for the given record.
 * 
 * @param record The record id
 * @returns The query writer
 */
export function delRecord(record: string): DeleteQueryWriter<null, 'maybe'>;

/**
 * Start a new DELETE query for the given record. This function
 * is especially useful in situations where the table name within a
 * record pointer may be spoofed, and a specific table name is required.
 * 
 * @param table The record table
 * @param id The record id, either the full id or just the unique id
 * @returns The query writer
 */
export function delRecord(table: string, id: string): DeleteQueryWriter<null, 'maybe'>;

export function delRecord(recordOrTable: string, id?: string) {
	return new DeleteQueryWriter({
		schema: null,
		quantity: 'maybe',
		targets: id === undefined ? assertRecordLink(recordOrTable) : thing(recordOrTable, id),
		where: undefined,
		returnMode: 'before',
		returnFields: [],
		timeout: undefined,
		parallel: false,
		unrelate: false
	});
}

/**
 * Start a new DELETE query that deletes the given relation. Since this
 * function will automatically configure a where clause, calling `.where()`
 * manually will throw an exception.
 * 
 * @param relation The relation information
 * @returns The query writer
 */
export function delRelation(relation: RecordRelation) {
	return new DeleteQueryWriter({
		schema: null,
		quantity: 'maybe',
		targets: relation.edge,
		where: parseWhereClause({
			in: eq(getRelationFrom(relation)),
			out: eq(getRelationTo(relation))
		}),
		returnMode: 'before',
		returnFields: [],
		timeout: undefined,
		parallel: false,
		unrelate: true
	});
}