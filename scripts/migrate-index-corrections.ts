import {pool,transaction} from '../lib/db';
import {indexCorrectionsSchema} from '../lib/index-corrections-schema';
try{await transaction(async db=>{await db.query("SET LOCAL lock_timeout='10s'");await db.query(indexCorrectionsSchema);});console.log('Index correction receipt/outbox migration applied.');}finally{await pool().end();}
