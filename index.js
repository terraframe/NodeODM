/*
Node-OpenDroneMap Node.js App and REST API to access OpenDroneMap.
Copyright (C) 2016 Node-OpenDroneMap Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
"use strict";

const fs = require('fs');
const config = require('./config.js');
const packageJson = JSON.parse(fs.readFileSync('./package.json'));

const logger = require('./libs/logger');
const path = require('path');
const async = require('async');
const mime = require('mime');
const rmdir = require('rimraf');

const express = require('express');
const app = express();

const multer = require('multer');
const bodyParser = require('body-parser');

const TaskManager = require('./libs/TaskManager');
const Task = require('./libs/Task');
const odmInfo = require('./libs/odmInfo');
const Directories = require('./libs/Directories');
const StreamZip = require('node-stream-zip');
const si = require('systeminformation');
const mv = require('mv');
const S3 = require('./libs/S3');

const auth = require('./libs/auth/factory').fromConfig(config);
const authCheck = auth.getMiddleware();
const uuidv4 = require('uuid/v4');

// zip files
let request = require('request');

let download = function(uri, filename, callback) {
    request.head(uri, function(err, res, body) {
        if (err) callback(err);
        else{
            request(uri).pipe(fs.createWriteStream(filename)).on('close', callback);
        }
    });
};

app.use(express.static('public'));
app.use('/swagger.json', express.static('docs/swagger.json'));

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            let dstPath = path.join("tmp", req.id);
            fs.exists(dstPath, exists => {
                if (!exists) {
                    fs.mkdir(dstPath, undefined, () => {
                        cb(null, dstPath);
                    });
                } else {
                    cb(null, dstPath);
                }
            });
        },
        filename: (req, file, cb) => {
            cb(null, file.originalname);
        }
    })
});

const urlEncodedBodyParser = bodyParser.urlencoded({extended: false});

let taskManager;
let server;

/** @swagger
 *  /task/new:
 *    post:
 *      description: Creates a new task and places it at the end of the processing queue
 *      tags: [task]
 *      consumes:
 *        - multipart/form-data
 *      parameters:
 *        -
 *          name: images
 *          in: formData
 *          description: Images to process, plus an optional GCP file. If included, the GCP file should have .txt extension
 *          required: false
 *          type: file
 *        -
 *          name: zipurl
 *          in: formData
 *          description: URL of the zip file containing the images to process, plus an optional GCP file. If included, the GCP file should have .txt extension
 *          required: false
 *          type: string
 *        -
 *          name: name
 *          in: formData
 *          description: An optional name to be associated with the task
 *          required: false
 *          type: string
 *        -
 *          name: options
 *          in: formData
 *          description: 'Serialized JSON string of the options to use for processing, as an array of the format: [{name: option1, value: value1}, {name: option2, value: value2}, ...]. For example, [{"name":"cmvs-maxImages","value":"500"},{"name":"time","value":true}]. For a list of all options, call /options'
 *          required: false
 *          type: string
 *        -
 *          name: skipPostProcessing
 *          in: formData
 *          description: 'When set, skips generation of map tiles, derivate assets, point cloud tiles.'
 *          required: false
 *          type: boolean
 *        -
 *          name: token
 *          in: query
 *          description: 'Token required for authentication (when authentication is required).'
 *          required: false
 *          type: string
 *        -
 *          name: set-uuid
 *          in: header
 *          description: 'An optional UUID string that will be used as UUID for this task instead of generating a random one.'
 *          required: false
 *          type: string
 *      responses:
 *        200:
 *          description: Success
 *          schema:
 *            type: object
 *            required: [uuid]
 *            properties:
 *              uuid:
 *                type: string
 *                description: UUID of the newly created task
 *        default:
 *          description: Error
 *          schema:
 *            $ref: '#/definitions/Error'
 */
app.post('/task/new', authCheck, (req, res, next) => {
    // A user can optionally suggest a UUID instead of letting
    // nodeODM pick one.
    if (req.get('set-uuid')){
        const userUuid = req.get('set-uuid');

        // Valid UUID and no other task with same UUID?
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userUuid) && !taskManager.find(userUuid)){
            req.id = userUuid;
            next();
        }else{
            res.json({error: `Invalid set-uuid: ${userUuid}`})
        }
    }else{
        req.id = uuidv4();
        next();
    }
}, upload.array('images'), (req, res) => {
    // TODO: consider doing the file moving in the background
    // and return a response more quickly instead of a long timeout.
    req.setTimeout(1000 * 60 * 20);

    let srcPath = path.join("tmp", req.id);

    // Print error message and cleanup
    const die = (error) => {
        res.json({error});

        // Check if tmp/ directory needs to be cleaned
        if (fs.stat(srcPath, (err, stats) => {
            if (!err && stats.isDirectory()) rmdir(srcPath, () => {}); // ignore errors, don't wait
        }));
    };

    if ((!req.files || req.files.length === 0) && !req.body.zipurl) die("Need at least 1 file or a zip file url.");
    else if (config.maxImages && req.files && req.files.length > config.maxImages) die(`${req.files.length} images uploaded, but this node can only process up to ${config.maxImages}.`);

    else {
        let destPath = path.join(Directories.data, req.id);
        let destImagesPath = path.join(destPath, "images");
        let destGpcPath = path.join(destPath, "gpc");

        async.series([
            cb => {
                odmInfo.filterOptions(req.body.options, (err, options) => {
                    if (err) cb(err);
                    else {
                        req.body.options = options;
                        cb(null);
                    }
                });
            },

            // Move all uploads to data/<uuid>/images dir (if any)
            cb => {
                if (req.files && req.files.length > 0) {
                    fs.stat(destPath, (err, stat) => {
                        if (err && err.code === 'ENOENT') cb();
                        else cb(new Error(`Directory exists (should not have happened: ${err.code})`));
                    });
                } else {
                    cb();
                }
            },

            // Unzips zip URL to tmp/<uuid>/ (if any)
            cb => {
                if (req.body.zipurl) {
                    let archive = "zipurl.zip";

                    upload.storage.getDestination(req, archive, (err, dstPath) => {
                        if (err) cb(err);
                        else{
                            let archiveDestPath = path.join(dstPath, archive);

                            download(req.body.zipurl, archiveDestPath, cb);
                        }
                    });
                } else {
                    cb();
                }
            },

            cb => fs.mkdir(destPath, undefined, cb),
            cb => fs.mkdir(destGpcPath, undefined, cb),
            cb => mv(srcPath, destImagesPath, cb),

            cb => {
                // Find any *.zip file and extract
                fs.readdir(destImagesPath, (err, entries) => {
                    if (err) cb(err);
                    else {
                        async.eachSeries(entries, (entry, cb) => {
                            if (/\.zip$/gi.test(entry)) {
                            	
                                const zip = new StreamZip({
                                    file: path.join(destImagesPath, entry),
                                    storeEntries: true
                                });
                                
                                zip.on('error', cb);
                                
                                zip.on('ready', () => {
                                    zip.extract(null, destImagesPath, (err, count) => {
                                      if (err) {
                                        logger.error(err.stack);
                                        cb('Extract error')
                                      }
                                      else
                                      {
                                        logger.info(`Extracted ${count} entries`);
                                      }
                                       
                                      zip.close();
                                        
                                       // Verify max images limit
                                      if (config.maxImages && count > config.maxImages) cb(`${count} images uploaded, but this node can only process up to ${config.maxImages}.`);
                                      else cb();
                                    });
                                });
                                
                            } else cb();
                        }, cb);
                    }
                });
            },

            cb => {
                // Find any *.txt (GPC) file and move it to the data/<uuid>/gpc directory
                // also remove any lingering zipurl.zip
                fs.readdir(destImagesPath, (err, entries) => {
                    if (err) cb(err);
                    else {
                        async.eachSeries(entries, (entry, cb) => {
                            if (/\.txt$/gi.test(entry)) {
                                mv(path.join(destImagesPath, entry), path.join(destGpcPath, entry), cb);
                            }else if (/\.zip$/gi.test(entry)){
                                fs.unlink(path.join(destImagesPath, entry), cb);
                            } else cb();
                        }, cb);
                    }
                });
            },

            // Create task
            cb => {
                new Task(req.id, req.body.name, (err, task) => {
                    if (err) cb(err);
                    else {
                        taskManager.addNew(task);
                        res.json({ uuid: req.id });
                        cb();
                    }
                }, req.body.options, 
                   req.body.webhook,
                   req.body.skipPostProcessing === 'true');
            }
        ], err => {
            if (err) die(err.message);
        });
    }

});

let getTaskFromUuid = (req, res, next) => {
    let task = taskManager.find(req.params.uuid);
    if (task) {
        req.task = task;
        next();
    } else res.json({ error: `${req.params.uuid} not found` });
};

/** @swagger
 *  /task/{uuid}/info:
 *     get:
 *       description: Gets information about this task, such as name, creation date, processing time, status, command line options and number of images being processed. See schema definition for a full list.
 *       tags: [task]
 *       parameters:
 *        -
 *           name: uuid
 *           in: path
 *           description: UUID of the task
 *           required: true
 *           type: string
 *        -
 *          name: options
 *          in: formData
 *          description: 'Serialized JSON string of the options to use for processing, as an array of the format: [{name: option1, value: value1}, {name: option2, value: value2}, ...]. For example, [{"name":"cmvs-maxImages","value":"500"},{"name":"time","value":true}]. For a list of all options, call /options'
 *          required: false
 *          type: string
 *        -
 *          name: token
 *          in: query
 *          description: 'Token required for authentication (when authentication is required).'
 *          required: false
 *          type: string
 *       responses:
 *        200:
 *         description: Task Information
 *         schema:
 *           title: TaskInfo
 *           type: object
 *           required: [uuid, name, dateCreated, processingTime, status, options, imagesCount]
 *           properties:
 *            uuid:
 *              type: string
 *              description: UUID
 *            name:
 *              type: string
 *              description: Name
 *            dateCreated:
 *              type: integer
 *              description: Timestamp
 *            processingTime:
 *              type: integer
 *              description: Milliseconds that have elapsed since the task started being processed.
 *            status:
 *              type: integer
 *              description: Status code (10 = QUEUED, 20 = RUNNING, 30 = FAILED, 40 = COMPLETED, 50 = CANCELED)
 *              enum: [10, 20, 30, 40, 50]
 *            options:
 *              type: array
 *              description: List of options used to process this task
 *              items:
 *                type: object
 *                required: [name, value]
 *                properties:
 *                  name:
 *                    type: string
 *                    description: 'Option name (example: "odm_meshing-octreeDepth")'
 *                  value:
 *                    type: string
 *                    description: 'Value (example: 9)'
 *            imagesCount:
 *              type: integer
 *              description: Number of images
 *        default:
 *          description: Error
 *          schema:
 *            $ref: '#/definitions/Error'
 */
app.get('/task/:uuid/info', authCheck, getTaskFromUuid, (req, res) => {
    res.json(req.task.getInfo());
});

/** @swagger
 *  /task/{uuid}/output:
 *     get:
 *       description: Retrieves the console output of the OpenDroneMap's process. Useful for monitoring execution and to provide updates to the user.
 *       tags: [task]
 *       parameters:
 *        -
 *           name: uuid
 *           in: path
 *           description: UUID of the task
 *           required: true
 *           type: string
 *        -
 *         name: line
 *         in: query
 *         description: Optional line number that the console output should be truncated from. For example, passing a value of 100 will retrieve the console output starting from line 100. Defaults to 0 (retrieve all console output).
 *         default: 0
 *         required: false
 *         type: integer
 *        -
 *          name: token
 *          in: query
 *          description: 'Token required for authentication (when authentication is required).'
 *          required: false
 *          type: string
 *       responses:
 *        200:
 *         description: Console Output
 *         schema:
 *           type: string
 *        default:
 *          description: Error
 *          schema:
 *            $ref: '#/definitions/Error'
 */
app.get('/task/:uuid/output', authCheck, getTaskFromUuid, (req, res) => {
    res.json(req.task.getOutput(req.query.line));
});

/** @swagger
 *  /task/{uuid}/download/{asset}:
 *    get:
 *      description: Retrieves an asset (the output of OpenDroneMap's processing) associated with a task
 *      tags: [task]
 *      produces: [application/zip]
 *      parameters:
 *        - name: uuid
 *          in: path
 *          type: string
 *          description: UUID of the task
 *          required: true
 *        - name: asset
 *          in: path
 *          type: string
 *          description: Type of asset to download. Use "all.zip" for zip file containing all assets.
 *          required: true
 *          enum:
 *            - all.zip
 *            - orthophoto.tif
 *        -
 *          name: token
 *          in: query
 *          description: 'Token required for authentication (when authentication is required).'
 *          required: false
 *          type: string
 *      responses:
 *        200:
 *          description: Asset File
 *          schema:
 *            type: file
 *        default:
 *          description: Error message
 *          schema:
 *            $ref: '#/definitions/Error'
 */
app.get('/task/:uuid/download/:asset', authCheck, getTaskFromUuid, (req, res) => {
    let asset = req.params.asset !== undefined ? req.params.asset : "all.zip";
    let filePath = req.task.getAssetsArchivePath(asset);
    if (filePath) {
        if (fs.existsSync(filePath)) {
            res.setHeader('Content-Disposition', `attachment; filename=${asset}`);
            res.setHeader('Content-Type', mime.getType(filePath));
            res.setHeader('Content-Length', fs.statSync(filePath).size);

            const filestream = fs.createReadStream(filePath);
            filestream.pipe(res);
        } else {
            res.json({ error: "Asset not ready" });
        }
    } else {
        res.json({ error: "Invalid asset" });
    }
});

/** @swagger
 * definition:
 *   Error:
 *     type: object
 *     required:
 *       - error
 *     properties:
 *       error:
 *         type: string
 *         description: Description of the error
 *   Response:
 *     type: object
 *     required:
 *       - success
 *     properties:
 *       success:
 *         type: boolean
 *         description: true if the command succeeded, false otherwise
 *       error:
 *         type: string
 *         description: Error message if an error occured
 */
let uuidCheck = (req, res, next) => {
    if (!req.body.uuid) res.json({ error: "uuid param missing and body is [" + JSON.stringify(req.body) + "]." });
    else next();
};

let successHandler = res => {
    return err => {
        if (!err) res.json({ success: true });
        else res.json({ success: false, error: err.message });
    };
};

/** @swagger
 * /task/cancel:
 *    post:
 *      description: Cancels a task (stops its execution, or prevents it from being executed)
 *      parameters:
 *        -
 *          name: uuid
 *          in: body
 *          description: UUID of the task
 *          required: true
 *          schema:
 *            type: string
 *        -
 *          name: token
 *          in: query
 *          description: 'Token required for authentication (when authentication is required).'
 *          required: false
 *          type: string
 *      responses:
 *        200:
 *          description: Command Received
 *          schema:
 *            $ref: "#/definitions/Response"
 */
app.post('/task/cancel', urlEncodedBodyParser, authCheck, uuidCheck, (req, res) => {
    taskManager.cancel(req.body.uuid, successHandler(res));
});

/** @swagger
 * /task/remove:
 *    post:
 *      description: Removes a task and deletes all of its assets
 *      parameters:
 *        -
 *          name: uuid
 *          in: body
 *          description: UUID of the task
 *          required: true
 *          schema:
 *            type: string
 *        -
 *          name: token
 *          in: query
 *          description: 'Token required for authentication (when authentication is required).'
 *          required: false
 *          type: string
 *      responses:
 *        200:
 *          description: Command Received
 *          schema:
 *            $ref: "#/definitions/Response"
 */
app.post('/task/remove', urlEncodedBodyParser, authCheck, uuidCheck, (req, res) => {
    taskManager.remove(req.body.uuid, successHandler(res));
});

/** @swagger
 * /task/restart:
 *    post:
 *      description: Restarts a task that was previously canceled, that had failed to process or that successfully completed
 *      parameters:
 *        -
 *          name: uuid
 *          in: body
 *          description: UUID of the task
 *          required: true
 *          schema:
 *            type: string
 *        -
 *          name: options
 *          in: body
 *          description: 'Serialized JSON string of the options to use for processing, as an array of the format: [{name: option1, value: value1}, {name: option2, value: value2}, ...]. For example, [{"name":"cmvs-maxImages","value":"500"},{"name":"time","value":true}]. For a list of all options, call /options. Overrides the previous options set for this task.'
 *          required: false
 *          schema:
 *            type: string
 *        -
 *          name: token
 *          in: query
 *          description: 'Token required for authentication (when authentication is required).'
 *          required: false
 *          type: string
 *      responses:
 *        200:
 *          description: Command Received
 *          schema:
 *            $ref: "#/definitions/Response"
 */
app.post('/task/restart', urlEncodedBodyParser, authCheck, uuidCheck, (req, res, next) => {
    if (req.body.options){
        odmInfo.filterOptions(req.body.options, (err, options) => {
            if (err) res.json({ error: err.message });
            else {
                req.body.options = options;
                next();
            }
        });
    } else next();
}, (req, res) => {
    taskManager.restart(req.body.uuid, req.body.options, successHandler(res));
});

/** @swagger
 * /options:
 *   get:
 *     description: Retrieves the command line options that can be passed to process a task
 *     parameters:
 *       -
 *         name: token
 *         in: query
 *         description: 'Token required for authentication (when authentication is required).'
 *         required: false
 *         type: string
 *     tags: [server]
 *     responses:
 *       200:
 *         description: Options
 *         schema:
 *           type: array
 *           items:
 *             title: Option
 *             type: object
 *             required: [name, type, value, domain, help]
 *             properties:
 *               name:
 *                 type: string
 *                 description: Command line option (exactly as it is passed to the OpenDroneMap process, minus the leading '--')
 *               type:
 *                 type: string
 *                 description: Datatype of the value of this option
 *                 enum:
 *                   - int
 *                   - float
 *                   - string
 *                   - bool
 *               value:
 *                 type: string
 *                 description: Default value of this option
 *               domain:
 *                 type: string
 *                 description: Valid range of values (for example, "positive integer" or "float > 0.0")
 *               help:
 *                 type: string
 *                 description: Description of what this option does
 */
app.get('/options', authCheck, (req, res) => {
    odmInfo.getOptions((err, options) => {
        if (err) res.json({ error: err.message });
        else res.json(options);
    });
});

/** @swagger
 * /info:
 *   get:
 *     description: Retrieves information about this node
 *     parameters:
 *       -
 *         name: token
 *         in: query
 *         description: 'Token required for authentication (when authentication is required).'
 *         required: false
 *         type: string
 *     tags: [server]
 *     responses:
 *       200:
 *         description: Info
 *         schema:
 *           type: object
 *           required: [version, taskQueueCount]
 *           properties:
 *             version:
 *               type: string
 *               description: Current API version
 *             taskQueueCount:
 *               type: integer
 *               description: Number of tasks currently being processed or waiting to be processed
 *             availableMemory:
 *               type: integer
 *               description: Amount of RAM available in bytes
 *             totalMemory:
 *               type: integer
 *               description: Amount of total RAM in the system in bytes
 *             cpuCores:
 *               type: integer
 *               description: Number of CPU cores (virtual)
 *             maxImages:
 *               type: integer
 *               description: Maximum number of images allowed for new tasks or null if there's no limit.
 *             maxParallelTasks:
 *               type: integer
 *               description: Maximum number of tasks that can be processed simultaneously
 *             odmVersion:
 *               type: string
 *               description: Current version of ODM
 */
app.get('/info', authCheck, (req, res) => {
    async.parallel({
        cpu: cb => si.cpu(data => cb(null, data)),
        mem: cb => si.mem(data => cb(null, data)),
        odmVersion: odmInfo.getVersion
    }, (_, data) => {
        const { cpu, mem, odmVersion } = data;

        // For testing
        if (req.query._debugUnauthorized){
            res.writeHead(401, "unauthorized")
            res.end();
            return;
        }

        res.json({
            version: packageJson.version,
            taskQueueCount: taskManager.getQueueCount(),
            totalMemory: mem.total,
            availableMemory: mem.available,
            cpuCores: cpu.cores,
            maxImages: config.maxImages,
            maxParallelTasks: config.parallelQueueProcessing,
            odmVersion: odmVersion
        });
    });
});

/** @swagger
 * /auth/info:
 *   get:
 *     description: Retrieves login information for this node.
 *     tags: [auth]
 *     responses:
 *       200:
 *         description: LoginInformation
 *         schema:
 *           type: object
 *           required: [message, loginUrl, registerUrl]
 *           properties:
 *             message:
 *               type: string
 *               description: Message to be displayed to the user prior to login/registration. This might include instructions on how to register or login, or to communicate that authentication is not available.
 *             loginUrl:
 *               type: string
 *               description: URL (absolute or relative) where to make a POST request to obtain a token, or null if login is disabled.
 *             registerUrl:
 *               type: string
 *               description: URL (absolute or relative) where to make a POST request to register a user, or null if registration is disabled.
 */
app.get('/auth/info', (req, res) => {
    res.json({
        message: "Authentication not available on this node", 
        loginUrl: null,
        registerUrl: null
    });
});

/** @swagger
 * /auth/login:
 *    post:
 *      description: Retrieve a token from a username/password pair.
 *      parameters:
 *        -
 *          name: username
 *          in: body
 *          description: Username
 *          required: true
 *          schema:
 *            type: string
 *        -
 *          name: password
 *          in: body
 *          description: Password
 *          required: true
 *          type: string
 *      responses:
 *        200:
 *          description: Login Succeeded
 *          schema:
 *            type: object
 *            required: [token]
 *            properties:
 *              token:
 *                type: string
 *                description: Token to be passed as a query parameter to other API calls.
 *        default:
 *          description: Error
 *          schema:
 *            $ref: '#/definitions/Error'
 */
app.post('/auth/login', (req, res) => {
    res.json({error: "Not available"});
});

/** @swagger
 * /auth/register:
 *    post:
 *      description: Register a new username/password.
 *      parameters:
 *        -
 *          name: username
 *          in: body
 *          description: Username
 *          required: true
 *          schema:
 *            type: string
 *        -
 *          name: password
 *          in: body
 *          description: Password
 *          required: true
 *          type: string
 *      responses:
 *        200:
 *          description: Response
 *          schema:
 *            $ref: "#/definitions/Response"
 */
app.post('/auth/register', (req, res) => {
    res.json({error: "Not available"});
});


app.use((err, req, res, next) => {
    logger.error(err.stack);
    res.json({error: err.message});
});

let gracefulShutdown = done => {
    async.series([
        cb => taskManager.dumpTaskList(cb),
        cb => auth.cleanup(cb),
        cb => {
            logger.info("Closing server");
            server.close();
            logger.info("Exiting...");
            process.exit(0);
        }
    ], done);
};

// listen for TERM signal .e.g. kill
process.on('SIGTERM', gracefulShutdown);

// listen for INT signal e.g. Ctrl-C
process.on('SIGINT', gracefulShutdown);

// Startup
if (config.test) logger.info("Running in test mode");

let commands = [
    cb => odmInfo.initialize(cb),
    cb => auth.initialize(cb),
    cb => S3.initialize(cb),
    cb => { taskManager = new TaskManager(cb); },
    cb => {
        server = app.listen(config.port, err => {
            if (!err) logger.info('Server has started on port ' + String(config.port));
            cb(err);
        });
    }
];

if (config.powercycle) {
    commands.push(cb => {
        logger.info("Power cycling is set, application will shut down...");
        process.exit(0);
    });
}

async.series(commands, err => {
    if (err) {
        logger.error("Error during startup: " + err.message);
        process.exit(1);
    }
});
