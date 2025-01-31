const debug = require('util').debuglog('ali-rds:operator');
const SqlString = require('./sqlstring');
const literals = require('./literals');

/**
 * Operator Interface
 */
class Operator {
  constructor() {
    this.literals = literals;
  }

  escape(value, stringifyObjects, timeZone) {
    return SqlString.escape(value, stringifyObjects, timeZone);
  }

  escapeId(value, forbidQualified) {
    return SqlString.escapeId(value, forbidQualified);
  }

  format(sql, values, stringifyObjects, timeZone) {
    // if values is object, not null, not Array;
    if (!Array.isArray(values) && typeof values === 'object' && values !== null) {
      // object not support replace column like ??;
      return sql.replace(/\:(\w+)/g, (text, key) => {
        if (values.hasOwnProperty(key)) {
          return SqlString.escape(values[key]);
        }
        // if values don't hasOwnProperty, return origin text;
        return text;
      });
    }
    return SqlString.format(sql, values, stringifyObjects, timeZone);
  }

  async query(sql, values) {
    // query(sql, values)
    if (arguments.length >= 2) {
      sql = this.format(sql, values);
    }
    debug('query %j', sql);
    try {
      const rows = await this._query(sql);
      debug('query get %d rows', rows.length);
      return rows;
    } catch (err) {
      err.stack = err.stack + '\n    sql: ' + sql;
      debug('query error: %s', err);
      throw err;
    }
  }

  async queryOne(sql, values) {
    const rows = await this.query(sql, values);
    return rows && rows[0] || null;
  }

  async _query(/* sql */) {
    throw new Error('SubClass must impl this');
  }

  async count(table, where) {
    const sql = this.format('SELECT COUNT(*) as count FROM ??', [ table ]) +
      this._where(where);
    debug('count(%j, %j) \n=> %j', table, where, sql);
    const rows = await this.query(sql);
    return rows[0].count;
  }

  /**
   * Select rows from a table
   *
   * @param  {String} table     table name
   * @param  {Object} [options] optional params
   *  - {Object} where          query condition object
   *  - {Array|String} columns  select columns, default is `'*'`
   *  - {Array|String} orders   result rows sort condition
   *  - {Number} limit          result limit count, default is no limit
   *  - {Number} offset         result offset, default is `0`
   * @return {Array} result rows
   */
  async select(table, options) {
    options = options || {};
    const sql = this._selectColumns(table, options.columns) +
      this._where(options.where) +
      this._orders(options.orders) +
      this._limit(options.limit, options.offset);
    debug('select(%j, %j) \n=> %j', table, options, sql);
    return await this.query(sql);
  }

  async get(table, where, options) {
    options = options || {};
    options.where = where;
    options.limit = 1;
    options.offset = 0;
    const rows = await this.select(table, options);
    return rows && rows[0] || null;
  }

  async insert(table, rows, options) {
    options = options || {};
    let firstObj;
    // insert(table, rows)
    if (Array.isArray(rows)) {
      firstObj = rows[0];
    } else {
      // insert(table, row)
      firstObj = rows;
      rows = [ rows ];
    }
    if (!options.columns) {
      options.columns = Object.keys(firstObj);
    }

    const params = [ table, options.columns ];
    const strs = [];
    for (const row of rows) {
      const values = [];
      for (const column of options.columns) {
        values.push(row[column]);
      }
      strs.push('(?)');
      params.push(values);
    }

    const sql = this.format('INSERT INTO ??(??) VALUES' + strs.join(', '), params);
    debug('insert(%j, %j, %j) \n=> %j', table, rows, options, sql);
    return await this.query(sql);
  }

  async update(table, row, options) {
    options = options || {};
    if (!options.columns) {
      options.columns = Object.keys(row);
    }
    if (!options.where) {
      if (!('id' in row)) {
        throw new Error('Can not auto detect update condition, please set options.where, or make sure obj.id exists');
      }
      options.where = {
        id: row.id,
      };
    }

    const sets = [];
    const values = [];
    for (const column of options.columns) {
      sets.push('?? = ?');
      values.push(column);
      values.push(row[column]);
    }
    const sql = this.format('UPDATE ?? SET ', [ table ]) +
      this.format(sets.join(', '), values) +
      this._where(options.where);
    debug('update(%j, %j, %j) \n=> %j', table, row, options, sql);
    return await this.query(sql);
  }

  /**
   *
   * Update multiple rows from a table
   *
   * UPDATE `table_name` SET
   *  `column1` CASE
   *     WHEN  condition1 THEN 'value11'
   *     WHEN  condition2 THEN 'value12'
   *     WHEN  condition3 THEN 'value13'
   *     ELSE `column1` END,
   *  `column2` CASE
   *     WHEN  condition1 THEN 'value21'
   *     WHEN  condition2 THEN 'value22'
   *     WHEN  condition3 THEN 'value23'
   *     ELSE `column2` END
   * WHERE condition
   *
   * See MySQL Case Syntax: https://dev.mysql.com/doc/refman/5.7/en/case.html
   *
   * @param {String} table table name
   * @param {Array<Object>} options Object Arrays
   *    each Object needs a primary key `id`, or each Object has `row` and `where` properties
   *    e.g.
   *      [{ id: 1, name: 'fengmk21' }]
   *      or [{ row: { name: 'fengmk21' }, where: { id: 1 } }]
   * @return {object} update result
   */
  async updateRows(table, options) {
    if (!Array.isArray(options)) {
      throw new Error('Options should be array');
    }

    /**
     * {
     *  column: {
     *    when: [ 'WHEN condition1 THEN ?', 'WHEN condition12 THEN ?' ],
     *    then: [ value1, value1 ]
     *  }
     * }
     */
    const SQL_CASE = {};
    // e.g. { id: [], column: [] }
    const WHERE = {};

    options.forEach(option => {
      if (!option.hasOwnProperty('id') && !(option.row && option.where)) {
        throw new Error('Can not auto detect updateRows condition, please set option.row and option.where, or make sure option.id exists');
      }

      // convert { id, column } to { row: { column }, where: { id } }
      if (option.hasOwnProperty('id')) {
        const where = { id: option.id };
        const row = Object.keys(option).reduce((result, key) => {
          if (key !== 'id') {
            result[key] = option[key];
          }
          return result;
        }, {});
        option = { row, where };
      }

      let where = this._where(option.where);
      where = where.indexOf('WHERE') === -1 ? where : where.substring(where.indexOf('WHERE') + 5);
      for (const key in option.row) {
        if (!SQL_CASE[key]) {
          SQL_CASE[key] = { when: [], then: [] };
        }
        SQL_CASE[key].when.push(' WHEN ' + where + ' THEN ? ');
        SQL_CASE[key].then.push(option.row[key]);
      }

      for (const key in option.where) {
        if (!WHERE[key]) {
          WHERE[key] = [];
        }
        if (WHERE[key].indexOf(option.where[key]) === -1) {
          WHERE[key].push(option.where[key]);
        }
      }
    });

    let SQL = [ 'UPDATE ?? SET ' ];
    let VALUES = [ table ];

    const TEMPLATE = [];
    for (const key in SQL_CASE) {
      let templateSql = ' ?? = CASE ';
      VALUES.push(key);
      templateSql += SQL_CASE[key].when.join(' ');
      VALUES = VALUES.concat(SQL_CASE[key].then);
      templateSql += ' ELSE ?? END ';
      TEMPLATE.push(templateSql);
      VALUES.push(key);
    }

    SQL += TEMPLATE.join(' , ');
    SQL += this._where(WHERE);

    /**
     * e.g.
     *
     * updateRows(table, [
     *  {id: 1, name: 'fengmk21', email: 'm@fengmk21.com'},
     *  {id: 2, name: 'fengmk22', email: 'm@fengmk22.com'},
     *  {id: 3, name: 'fengmk23', email: 'm@fengmk23.com'},
     * ])
     *
     * UPDATE `ali-sdk-test-user` SET
     *  `name` =
     *    CASE
     *      WHEN  `id` = 1 THEN 'fengmk21'
     *      WHEN  `id` = 2 THEN 'fengmk22'
     *      WHEN  `id` = 3 THEN 'fengmk23'
     *      ELSE `name` END,
     *  `email` =
     *    CASE
     *      WHEN  `id` = 1 THEN 'm@fengmk21.com'
     *      WHEN  `id` = 2 THEN 'm@fengmk22.com'
     *      WHEN  `id` = 3 THEN 'm@fengmk23.com'
     *      ELSE `email` END
     *  WHERE `id` IN (1, 2, 3)
     */
    const sql = this.format(SQL, VALUES);
    debug('updateRows(%j, %j) \n=> %j', table, options, sql);
    return await this.query(sql);
  }

  async delete(table, where) {
    const sql = this.format('DELETE FROM ??', [ table ]) +
      this._where(where);
    debug('delete(%j, %j) \n=> %j', table, where, sql);
    return await this.query(sql);
  }

  _where(where) {
    if (!where) {
      return '';
    }

    const wheres = [];
    const values = [];
    for (const key in where) {
      const value = where[key];
      if (Array.isArray(value)) {
        wheres.push('?? IN (?)');
      } else {
        if (value === null || value === undefined) {
          wheres.push('?? IS ?');
        } else {
          wheres.push('?? = ?');
        }
      }
      values.push(key);
      values.push(value);
    }
    if (wheres.length > 0) {
      return this.format(' WHERE ' + wheres.join(' AND '), values);
    }
    return '';
  }

  _selectColumns(table, columns) {
    if (!columns) {
      columns = '*';
    }
    let sql;
    if (columns === '*') {
      sql = this.format('SELECT * FROM ??', [ table ]);
    } else {
      sql = this.format('SELECT ?? FROM ??', [ columns, table ]);
    }
    return sql;
  }

  _orders(orders) {
    if (!orders) {
      return '';
    }
    if (typeof orders === 'string') {
      orders = [ orders ];
    }
    const values = [];
    for (const value of orders) {
      if (typeof value === 'string') {
        values.push(this.escapeId(value));
      } else if (Array.isArray(value)) {
        // value format: ['name', 'desc'], ['name'], ['name', 'asc']
        let sort = String(value[1]).toUpperCase();
        if (sort !== 'ASC' && sort !== 'DESC') {
          sort = null;
        }
        if (sort) {
          values.push(this.escapeId(value[0]) + ' ' + sort);
        } else {
          values.push(this.escapeId(value[0]));
        }
      }
    }
    return ' ORDER BY ' + values.join(', ');
  }

  _limit(limit, offset) {
    if (!limit || typeof limit !== 'number') {
      return '';
    }
    if (typeof offset !== 'number') {
      offset = 0;
    }
    return ' LIMIT ' + offset + ', ' + limit;
  }

  /**
   * Lock tables.
   * @param {object[]} tables table lock descriptions.
   * @description
   * LOCK TABLES
   *   tbl_name [[AS] alias] lock_type
   *   [, tbl_name [[AS] alias] lock_type] ...
   * lock_type: {
   *   READ [LOCAL]
   *   | [LOW_PRIORITY] WRITE
   * }
   * For more details:
   * https://dev.mysql.com/doc/refman/8.0/en/lock-tables.html
   * @example
   * await locks([{ tableName: 'posts', lockType: 'READ', tableAlias: 't' }]);
   */
  async locks(tables) {
    const sql = this.#locks(tables);
    debug('lock tables \n=> %j', sql);
    return await this.query(sql);
  }

  /**
   * Lock a single table.
   * @param {string} tableName
   * @param {string} lockType
   * @param {string} tableAlias
   * @description
   * LOCK TABLES
   *   tbl_name [[AS] alias] lock_type
   *   [, tbl_name [[AS] alias] lock_type] ...
   * lock_type: {
   *   READ [LOCAL]
   *   | [LOW_PRIORITY] WRITE
   * }
   * For more details:
   * https://dev.mysql.com/doc/refman/8.0/en/lock-tables.html
   * @example
   * await lockOne('posts_table', 'READ', 't'); // LOCK TABLS 'posts_table' AS t READ
   */
  async lockOne(tableName, lockType, tableAlias) {
    const sql = this.#locks([{
      tableName,
      lockType,
      tableAlias,
    }]);
    debug('lock one table \n=> %j', sql);
    return await this.query(sql);
  }

  #locks(tableLocks) {
    if (tableLocks.length === 0) {
      throw new Error('Cannot lock empty tables.');
    }
    let sql = 'LOCK TABLES ';
    for (let i = 0; i < tableLocks.length; i++) {
      const table = tableLocks[i];
      const { tableName, lockType, tableAlias } = table;
      if (!tableName) {
        throw new Error('No table_name provided while trying to lock table');
      }
      if (!lockType) {
        throw new Error('No lock_type provided while trying to lock table `' + tableName + '`');
      }
      if ([ 'READ', 'WRITE', 'READ LOCAL', 'LOW_PRIORITY WRITE' ].indexOf(lockType.toUpperCase()) < 0) {
        throw new Error('lock_type provided while trying to lock table `' + tableName +
        '` must be one of the following(CASE INSENSITIVE):\n`READ` | `WRITE` | `READ LOCAL` | `LOW_PRIORITY WRITE`');
      }
      if (i > 0) {
        sql += ', ';
      }
      sql += ' ' + this.escapeId(tableName) + ' ';
      if (tableAlias) {
        sql += ' AS ' + this.escapeId(tableAlias) + ' ';
      }
      sql += ' ' + lockType;
    }
    return sql + ';';
  }

  /**
   * To unlock all tables locked in current session.
   * For more details:
   * https://dev.mysql.com/doc/refman/8.0/en/lock-tables.html
   * @example
   * await unlock(); // unlock all tables.
   */
  async unlock() {
    debug('unlock tables');
    return await this.query('UNLOCK TABLES;');
  }
}

module.exports = Operator;
