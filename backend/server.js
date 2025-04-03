const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const retry = require('async-retry');

const app = express();
app.use(cors());
app.use(express.json());

// Configuración de PostgreSQL con manejo de errores mejorado
const createPool = () => {
    return new Pool({
        user: process.env.DB_USER || 'postgres',     // Usuario para conectar a PostgreSQL
        host: process.env.DB_HOST || 'db',           // Nombre del servicio de base de datos en Docker Compose
        database: process.env.DB_NAME || 'inventariofacil',
        password: process.env.DB_PASSWORD || 'inventariofacil123',
        port: process.env.DB_PORT || 5432,           // Puerto de PostgreSQL dentro del contenedor
        max: 20,                                     // Máximo de conexiones en el pool
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000
    });
};

let pool = createPool();

// Función para probar la conexión con reintentos
async function testConnection() {
    return retry(
        async (bail) => {
            try {
                const client = await pool.connect();
                client.release();
                console.log('✅ Conexión a PostgreSQL establecida correctamente');
            } catch (err) {
                console.warn('⚠️ Intento de conexión fallido. Reintentando...');
                throw err; // Esto hace que retry reintente
            }
        },
        {
            retries: 10,
            minTimeout: 1000,
            maxTimeout: 5000,
            onRetry: (err, attempt) => {
                console.log(`🔁 Intento ${attempt} de conexión a la base de datos`);
            }
        }
    );
}

// Middleware para manejo de errores de la base de datos
app.use((err, req, res, next) => {
    if (err.code === 'ECONNREFUSED') {
        // Recrear el pool si la conexión falla
        pool = createPool();
        return res.status(503).json({
            success: false,
            error: 'Servicio no disponible. Intente nuevamente.'
        });
    }
    next(err);
});

// ================== RUTAS PRINCIPALES ================== //

app.get('/', (req, res) => {
    res.send(`
        <h1>Sistema de Inventario - Tienda</h1>
        <p>API funcionando correctamente</p>
        <p>Endpoints disponibles:</p>
        <ul>
          <li>GET /productos</li>
          <li>POST /productos</li>
          <li>POST /registrar</li>
          <li>POST /transacciones</li>
          <li>GET /stock-bajo</li>
        </ul>
    `);
});

// ================== RUTAS DE USUARIOS ================== //

app.post('/registrar', async (req, res) => {
    const { nombre, email, password, role_id } = req.body;
    const client = await pool.connect();

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await client.query(
            `INSERT INTO usuarios (nombre, email, password, role_id)
            VALUES ($1, $2, $3, $4) RETURNING *`,
            [nombre, email, hashedPassword, role_id || 3]
        );

        res.status(201).json({
            success: true,
            usuario: {
                id: result.rows[0].id,
                nombre: result.rows[0].nombre,
                email: result.rows[0].email,
                role_id: result.rows[0].role_id
            }
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.code === '23505' ? 'El email ya existe' : 'Error al registrar usuario'
        });
    } finally {
        client.release();
    }
});

// ================== RUTAS DE PRODUCTOS ================== //

app.get('/productos', async (req, res) => {
    const client = await pool.connect();

    try {
        const result = await client.query(`SELECT * FROM productos;`);
        res.json({
            success: true,
            productos: result.rows
        });
    } catch (err) {
        console.error('Error al obtener productos:', err);
        res.status(500).json({
            success: false,
            error: 'Error al obtener productos',
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    } finally {
        client.release();
    }
});

app.post('/productos', async (req, res) => {
    const { nombre, descripcion, precio, cantidad } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await client.query(
            `INSERT INTO productos (nombre, descripcion, precio, cantidad)
            VALUES ($1, $2, $3, $4) RETURNING *`,
            [nombre, descripcion, precio, cantidad || 0]
        );

        await client.query('COMMIT');
        res.status(201).json({
            success: true,
            producto: result.rows[0]
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({
            success: false,
            error: err.code === '23505' ? 'Producto ya existe' : 'Error al crear producto'
        });
    } finally {
        client.release();
    }
});

// ================== RUTAS DE TRANSACCIONES ================== //

app.post('/transacciones', async (req, res) => {
    const { tipo, cantidad, producto_id, usuario_id } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Verificar producto
        const producto = await client.query(
            'SELECT * FROM productos WHERE id = $1 FOR UPDATE',
            [producto_id]
        );

        if (producto.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Producto no encontrado'
            });
        }

        // Actualizar inventario
        const nuevaCantidad = tipo === 'entrada'
            ? producto.rows[0].cantidad + cantidad
            : producto.rows[0].cantidad - cantidad;

        if (nuevaCantidad < 0) {
            return res.status(400).json({
                success: false,
                error: `Stock insuficiente. Disponible: ${producto.rows[0].cantidad}`
            });
        }

        await client.query(
            'UPDATE productos SET cantidad = $1 WHERE id = $2',
            [nuevaCantidad, producto_id]
        );

        // Registrar transacción
        const transaccion = await client.query(
            `INSERT INTO transacciones (tipo, cantidad, producto_id, usuario_id)
            VALUES ($1, $2, $3, $4) RETURNING *`,
            [tipo, cantidad, producto_id, usuario_id]
        );

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            transaccion: transaccion.rows[0],
            stock_actual: nuevaCantidad
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({
            success: false,
            error: 'Error en la transacción',
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    } finally {
        client.release();
    }
});

// ================== NUEVA RUTA PARA STOCK BAJO ================== //

app.get('/stock-bajo', async (req, res) => {
    const { min = 10 } = req.query; // Umbral configurable
    const client = await pool.connect();

    try {
        const result = await client.query(
            `SELECT id, nombre, cantidad 
            FROM productos 
            WHERE cantidad < $1 
            ORDER BY cantidad ASC`,
            [min]
        );

        res.json({
            success: true,
            productos: result.rows,
            umbral: min
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: 'Error al obtener productos con stock bajo'
        });
    } finally {
        client.release();
    }
});

// Ruta para generar el reporte diario
app.get('/reporte-diario', async (req, res) => {
    try {
        // Consulta SQL para generar el reporte diario
        const reporteDiarioQuery = `
            WITH transacciones_diarias AS (
                -- Calcular entradas
                SELECT 
                    p.nombre AS producto,
                    SUM(t.cantidad * p.precio) AS dinero_entrada,
                    0 AS dinero_salida,
                    CURRENT_DATE AS fecha_reporte
                FROM 
                    transacciones t
                JOIN 
                    productos p ON t.producto_id = p.id
                WHERE 
                    t.tipo = 'entrada'
                    AND t.fecha_transaccion >= CURRENT_DATE
                    AND t.fecha_transaccion < CURRENT_DATE + INTERVAL '1 day'
                GROUP BY 
                    p.nombre

                UNION ALL

                -- Calcular salidas
                SELECT 
                    p.nombre AS producto,
                    0 AS dinero_entrada,
                    SUM(t.cantidad * p.precio) AS dinero_salida,
                    CURRENT_DATE AS fecha_reporte
                FROM 
                    transacciones t
                JOIN 
                    productos p ON t.producto_id = p.id
                WHERE 
                    t.tipo = 'salida'
                    AND t.fecha_transaccion >= CURRENT_DATE
                    AND t.fecha_transaccion < CURRENT_DATE + INTERVAL '1 day'
                GROUP BY 
                    p.nombre
            )
            -- Calcular totales y ganancias
            SELECT 
                producto,
                SUM(dinero_entrada) AS total_entrada,
                SUM(dinero_salida) AS total_salida,
                (SUM(dinero_entrada) - SUM(dinero_salida)) AS ganancia
            FROM 
                transacciones_diarias
            GROUP BY 
                producto;
        `;

        // Ejecutar la consulta
        const result = await pool.query(reporteDiarioQuery);

        // Devolver el resultado al cliente
        res.status(200).json({
            success: true,
            reporte: result.rows
        });
    } catch (err) {
        console.error('Error al generar el reporte diario:', err);
        res.status(500).json({ error: 'Error al generar el reporte diario' });
    }
});

// Ruta para generar el reporte mensual
app.get('/reporte-mensual', async (req, res) => {
    try {
        // Consulta SQL para generar el reporte mensual
        const reporteMensualQuery = `
            WITH transacciones_mensuales AS (
                -- Calcular entradas
                SELECT 
                    p.nombre AS producto,
                    SUM(t.cantidad * p.precio) AS dinero_entrada,
                    0 AS dinero_salida,
                    DATE_TRUNC('month', CURRENT_DATE) AS fecha_reporte
                FROM 
                    transacciones t
                JOIN 
                    productos p ON t.producto_id = p.id
                WHERE 
                    t.tipo = 'entrada'
                    AND t.fecha_transaccion >= DATE_TRUNC('month', CURRENT_DATE)
                    AND t.fecha_transaccion < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
                GROUP BY 
                    p.nombre

                UNION ALL

                -- Calcular salidas
                SELECT 
                    p.nombre AS producto,
                    0 AS dinero_entrada,
                    SUM(t.cantidad * p.precio) AS dinero_salida,
                    DATE_TRUNC('month', CURRENT_DATE) AS fecha_reporte
                FROM 
                    transacciones t
                JOIN 
                    productos p ON t.producto_id = p.id
                WHERE 
                    t.tipo = 'salida'
                    AND t.fecha_transaccion >= DATE_TRUNC('month', CURRENT_DATE)
                    AND t.fecha_transaccion < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
                GROUP BY 
                    p.nombre
            )
            -- Calcular totales y ganancias
            SELECT 
                producto,
                SUM(dinero_entrada) AS total_entrada,
                SUM(dinero_salida) AS total_salida,
                (SUM(dinero_entrada) - SUM(dinero_salida)) AS ganancia
            FROM 
                transacciones_mensuales
            GROUP BY 
                producto;
        `;

        // Ejecutar la consulta
        const result = await pool.query(reporteMensualQuery);

        // Devolver el resultado al cliente
        res.status(200).json({
            success: true,
            reporte: result.rows
        });
    } catch (err) {
        console.error('Error al generar el reporte mensual:', err);
        res.status(500).json({ error: 'Error al generar el reporte mensual' });
    }
});

// ================== INICIAR SERVIDOR ================== //

const PORT = process.env.PORT || 5000;

async function startServer() {
    try {
        console.log('⏳ Iniciando servidor...');
        await testConnection();  // Intenta establecer la conexión a la base de datos

        app.listen(PORT, () => {
            console.log(`🛒 Servidor de inventario corriendo en http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('❌ Error crítico al iniciar:', err.message);
        process.exit(1); // Si no se puede conectar a la base de datos, termina el proceso
    }
}


startServer();

// Manejo de cierre limpio
process.on('SIGTERM', async () => {
    console.log('🛑 Recibida señal de terminación. Cerrando pool de conexiones...');
    await pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('🛑 Recibida interrupción. Cerrando pool de conexiones...');
    await pool.end();
    process.exit(0);
});
