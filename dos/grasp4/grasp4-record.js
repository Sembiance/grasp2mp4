#!/usr/bin/env node
"use strict";
const XU = require("@sembiance/xu"),
	fileUtil = require("@sembiance/xutil").file,
	runUtil = require("@sembiance/xutil").run,
	fs = require("fs"),
	path = require("path");

fs.copyFileSync(process.argv[2], path.join(__dirname, "IN.GL"));
const VIDEO_FILE_PATH = path.join(__dirname, `${path.basename(process.argv[2], path.extname(process.argv[2]))}.mp4`);
if(fileUtil.existsSync(VIDEO_FILE_PATH))
	fileUtil.unlinkSync(VIDEO_FILE_PATH);

runUtil.run("dosbox", ["-conf", "dosbox.conf"], {cwd : __dirname, recordVideoFilePath : VIDEO_FILE_PATH, silent : true, virtualX : true, dontCropVideo : true}, XU.FINISH);
