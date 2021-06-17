#!/usr/bin/env node
"use strict";
const XU = require("@sembiance/xu"),
	fileUtil = require("@sembiance/xutil").file,
	runUtil = require("@sembiance/xutil").run,
	cmdUtil = require("@sembiance/xutil").cmd,
	fs = require("fs"),
	path = require("path"),
	tiptoe = require("tiptoe");

const argv = cmdUtil.cmdInit({
	version     : "1.0.0",
	desc : "Convert a GRASP GL file into one or more MP4 files",
	opts        :
	{
		force       : {desc : "Overwrite any existing MP4 files in outDirPath"},
		rate        : {desc : "Frame rate to use for output video", defaultValue : 60},
		keep        : {desc : "Keep temporary working files around"},
		quiet       : {desc : "Don't output any progress messages"},
		speed       : {desc : "How fast to render the video", defaultValue : 150},
		maxDuration : {desc : "Maximum duration of video, in seconds", noShort : true, defaultValue : 300}
	},
	args :
	[
		{argid : "graspFilePath", desc : "Input grasp.gl file path", required : true},
		{argid : "outDirPath", desc : "Output directory", required : true}
	]});

if(!fileUtil.existsSync(argv.graspFilePath))
	process.exit(XU.log`graspFilePath file path ${argv.graspFilePath} does not exist`);

argv.maxFrames = argv.rate*argv.maxDuration;

function grasp2mp4(cb)
{
	if(!fileUtil.existsSync(argv.outDirPath))
		fs.mkdirSync(argv.outDirPath, {recursive : true});

	const wipDirPath = fileUtil.generateTempFilePath();
	fs.mkdirSync(wipDirPath, {recursive : true}, this);

	const glFilesDirPath = fileUtil.generateTempFilePath(wipDirPath, "-glFilesDirPath");
	fs.mkdirSync(glFilesDirPath, {recursive : true}, this);

	tiptoe(
		function extractGLFiles()
		{
			runUtil.run("deark", ["-od", glFilesDirPath, "-o", "_", argv.graspFilePath], runUtil.SILENT, this);
		},
		function findGLFiles()
		{
			fileUtil.glob(glFilesDirPath, "**", {nodir : true}, this);
		},
		function processScriptFile(glFilePaths)
		{
			const scripts = {};
			const baseState = {glFilesDirPath, outDirPath : argv.outDirPath, pics : {}, clips : {}, wipDirPath};
			glFilePaths.forEach(glFilePath =>
			{
				// Rename files so they don't have the dexvert prefix. We assume all filenames will be unique
				const newFilePath = path.join(path.dirname(glFilePath), path.basename(glFilePath).replace(/^_\.\d+\./, ""));
				fs.renameSync(glFilePath, newFilePath);
				const fileNameNoExt = path.basename(newFilePath, path.extname(newFilePath));

				const glFileExt = path.extname(glFilePath).toLowerCase();
				if(glFileExt===".txt")
				{
					// Scripts end with .txt
					const scriptContent = fs.readFileSync(newFilePath, XU.UTF8);
					scripts[fileNameNoExt] = scriptContent.includes("\n") ? scriptContent.replaceAll("\r", "").split("\n") : scriptContent.split("\r");
					
					// Ignore blank lines and lines that start with a comment
					scripts[fileNameNoExt].filterInPlace(line => line.trim().length>0 && !line.trim().startsWith(";"));
				}
				else if(glFileExt===".pic")
				{
					baseState.pics[fileNameNoExt] = newFilePath;
					baseState.pics[path.basename(newFilePath)] = newFilePath;
				}
				else if(glFileExt===".clp")
				{
					baseState.clips[fileNameNoExt] = newFilePath;
					baseState.clips[path.basename(newFilePath)] = newFilePath;
				}
			});
	
			Object.entries(scripts).serialForEach(([scriptName, scriptLines], subcb) => processScript({...baseState, scriptName, scriptLines}, subcb), this);
		},
		function cleanup()
		{
			if(!argv.quiet)
				XU.log`All done! Cleaning up...`;

			if(argv.keep)
			{
				XU.log`Keeping files in dir ${wipDirPath}`;
				this();
			}
			else
			{
				fileUtil.unlink(wipDirPath, this);
			}
		},
		cb
	);
}

function processScript(state, cb)
{
	if(!argv.quiet)
		XU.log`Processing script ${state.scriptName} with ${state.scriptLines.length} lines...`;

	state.framesDirPath = fileUtil.generateTempFilePath(state.wipDirPath, "-framesDirPath");
	fs.mkdirSync(state.framesDirPath);

	const outMP4FilePath = path.join(state.outDirPath, `${state.scriptName}.mp4`);
	if(fileUtil.existsSync(outMP4FilePath))
	{
		if(!argv.force)
		{
			if(!argv.quiet)
				XU.log`Skipping ${state.scriptName} due to output MP4 already existing: ${outMP4FilePath}`;
			return setImmediate(cb);
		}
		
		fileUtil.unlinkSync(outMP4FilePath);
	}

	state.l = 0;	// Current line being executed
	state.f = 0;	// Frame counter
	state.labels = {};	// label : lineNum
	state.marks = {};	// lineNum : count
	state.picBuf = {};
	state.clipBuf = {};
	state.backgroundColor = "black";
	state.prepared = {clips : {}, pics : {}};

	tiptoe(
		function processLines()
		{
			processLine(state, this);
		},
		function makeMovie()
		{
			const ffmpegArgs = ["-r", argv.rate, "-f", "image2", "-s", state.video.resolution.join("x"), "-i", `%0${argv.maxFrames.toString().length}d.png`];
			ffmpegArgs.push("-c:v", "libx264", "-crf", "15", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "faststart", path.resolve(outMP4FilePath));
			runUtil.run("ffmpeg", ffmpegArgs, {cwd : state.framesDirPath, silent : true}, this);
		},
		cb
	);
}

const msg = (state, msgData, cb) =>
{
	XU.log`${state.scriptName}@${state.l.toLocaleString().padStart(state.scriptLines.length.toLocaleString().length, " ")}: ${XU.cf.fg.white(msgData)}`;
	//XU.log`state: ${state}`;
	if(cb)
		setImmediate(cb);
};

const cmds = {};

// VIDEO mode - Switches screen video mode
cmds.VIDEO = (argRaw, state, cb) =>
{
	const MODES =
	{
		/* eslint-disable array-bracket-spacing, no-multi-spaces */
		"0" : {resolution : [ 40,  25], colors :  16, type : "IBM 40 column text"},
		"1" : {resolution : [ 80,  25], colors :  16, type : "IBM 80 column text"},
		"2" : {resolution : [ 80,  25], colors :   2, type : "IBM 80 column text"},
		"A" : {resolution : [320, 200], colors :   4, type : "IBM CGA"},
		"B" : {resolution : [320, 200], colors :  16, type : "IBM PCjr/STB"},
		"C" : {resolution : [640, 200], colors :   2, type : "IBM CGA"},
		"D" : {resolution : [640, 200], colors :  64, type : "IBM EGA"},
		"E" : {resolution : [640, 350], colors :   2, type : "IBM EGA monochrome"},
		"F" : {resolution : [640, 350], colors :   4, type : "IBM EGA"},
		"G" : {resolution : [640, 350], colors :  64, type : "IBM EGA"},
		"H" : {resolution : [720, 348], colors :   2, type : "Hercules monochrome"},
		"I" : {resolution : [320, 200], colors :  16, type : "Plantronics/AST CGP"},
		"J" : {resolution : [320, 200], colors :  16, type : "IBM EGA"},
		// Modes below this line were not documented in the 1.10c docs, looking for further docs
		"L" : {resolution : [320, 200], colors : 256, type : "IBM VGA"}
		/* eslint-enable array-bracket-spacing, no-multi-spaces */
	};

	const mode = argRaw.trim().toUpperCase();
	if(!MODES[mode])
		return msg(state, `VIDEO Unsupported mode ${mode} (${argRaw})`, cb);
	
	state.video = MODES[mode];
	cb();
};

// PLOAD picName,bufNum - Load a picture into a picBuf
cmds.PLOAD = (argRaw, state, cb) =>
{
	const [picName, bufNum] = argRaw.split(",").map(v => v.trim());
	state.picBuf[bufNum] = picName;
	cb();
};

// PALETTE bufNum - Set the current working pallete from a pic in picBuf
cmds.PALETTE = (argRaw, state, cb) =>
{
	const bufNum = argRaw.trim();
	if(!state.picBuf[bufNum])
		return msg(state, `PALETTE No pic buf loaded in ${bufNum} (${argRaw})`, cb);

	// Changing palettes, let's ditch any prepared clips/cips
	state.prepared = {clips : {}, pics : {}};
	state.palette = state.picBuf[bufNum];
	cb();
};

// PFREE bufNum, bufNum, bufNum... - Frees the given picture buffers
cmds.PFREE = (argRaw, state, cb) =>
{
	argRaw.split(",").map(v => v.trim()).forEach(bufNum =>
	{
		if(!state.picBuf[bufNum])
			msg(state, `PFREE No pic buf loaded in ${bufNum} (${argRaw})`);
		else
			delete state.picBuf[bufNum];
	});

	cb();
};

// CLOAD clipName, bufNum, shiftParm - Loads a clip into a clipBuf
cmds.CLOAD = (argRaw, state, cb) =>
{
	const [clipName, bufNum] = argRaw.split(",").map(v => v.trim());
	state.clipBuf[bufNum] = clipName;
	cb();
};

// FLY startX, startY, endX, endY, flyInc, flyDelay, clip1, clip2, ...clipn - Animate 1 or more clippings between two points on the screen
cmds.FLY = (argRaw, state, cb) =>
{
	const [startX, startY, endX, endY, flyInc, delay, ...clipNums] = argRaw.split(",").map(v => v.trim());

	tiptoe(
		function prepareClips()
		{
			prepareImages(state, clipNums.unique().map(clipNum => state.clipBuf[clipNum]), "clips", this);
		},
		function generateFrames()
		{
			const frames = [];
			let x = startX;
			let y = startY;
			let seenAllClips = false;
			const clipsLeft = Array.from(clipNums);
			for(;x!==endX || y!==endY || (!seenAllClips && clipsLeft.length>0);)
			{
				frames.push({x, y, imageFilePath : state.prepared.clips[state.clipBuf[clipsLeft.shift()]], delay});

				if(clipsLeft.length===0)
				{
					seenAllClips = true;
					clipsLeft.push(...clipNums);
				}

				if(startX<endX)
				{
					x += flyInc;
					x = Math.min(x, endX);
				}
				else if(startX>endX)
				{
					x -= Math.abs(flyInc);
					x = Math.max(x, endX);
				}

				if(startY<endY)
				{
					y += flyInc;
					y = Math.min(y, endY);
				}
				else if(startY>endY)
				{
					y -= Math.abs(flyInc);
					y = Math.max(y, endY);
				}
			}

			frames.serialForEach((frame, subcb) => writeFrame(state, frame, subcb), this);
		},
		function returnResult(err) { cb(err); }
	);
};

// GOTO labelName - Jump to the given label in the program
cmds.GOTO = (argRaw, state, cb) =>
{
	const labelName = argRaw.trim();
	if(!state.labels.hasOwnProperty(labelName))
		return msg(state, `GOTO Label not found yet ${labelName}`, cb);
		
	cb(undefined, state.labels[labelName]);
};

// MARK markCount - Marks the place that LOOP will return to
cmds.MARK = (argRaw, state, cb) =>
{
	// If we've already found a mark on this line, just continue
	if(state.marks.hasOwnProperty(state.l))
		return cb();
	
	const markCount = argRaw.trim();
	state.marks[state.l] = +markCount;
	cb();
};

// LOOP - Will loop back up to the nearest MARK that still has counts remaining
cmds.LOOP = (argRaw, state, cb) =>
{
	const targetMarkLine = Object.entries(state.marks).filter(([markLine, markCount]) => markCount>0 && (+markLine)<state.l).map(([markLine]) => +markLine).multiSort([v => +v]).pop();
	if(typeof targetMarkLine==="undefined")
		return cb();

	XU.log`Looping back to ${targetMarkLine} with ${state.marks[targetMarkLine]} loops remaining...`;
	state.marks[targetMarkLine]--;
	cb(undefined, targetMarkLine);
};

function getFrameFilePath(state)
{
	return path.join(state.framesDirPath, `${state.f.toString().padStart(argv.maxFrames.toString().length, "0")}.png`);
}

function writeFrame(state, frame, cb)
{
	const frameFilePath = getFrameFilePath(state);
	state.f++;

	tiptoe(
		function writeFrameFile()
		{
			runUtil.run("convert", ["-size", state.video.resolution.join("x"), `xc:${state.backgroundColor}`, frame.imageFilePath, "-geometry", `+${frame.x}+${frame.y}`, "-composite", frameFilePath], runUtil.SILENT, this);
		},
		function createDelaySymlinks()
		{
			if(!frame.delay)
				return this();

			const msPerFrame = (XU.SECOND/argv.rate);
			const delayFrameCount = Math.floor((frame.delay*(XU.SECOND/argv.speed))/msPerFrame);
			[].pushSequence(0, delayFrameCount-1).serialForEach((i, subcb) =>
			{
				const symlinkFramePath = getFrameFilePath(state);
				state.f++;
				fs.symlink(path.basename(frameFilePath), symlinkFramePath, subcb);
			}, this);
		},
		cb
	);
}

// Will pre-convert the given images into PNG, using state.palette if set
function prepareImages(state, imageNames, imageType, cb)
{
	const prepDirPath = fileUtil.generateTempFilePath(state.wipDirPath, "-prepareImages");
	fs.mkdirSync(prepDirPath);

	imageNames.parallelForEach((imageName, subcb) =>
	{
		if(state.prepared[imageType][imageName])
			return setImmediate(subcb);

		tiptoe(
			function convertImage()
			{
				const dearkArgs = ["-od", prepDirPath, "-o", `${imageType}-${imageName}`, "-m", "pcpaint"];
				if(state.palette)
					dearkArgs.push("-file2", state.pics[state.palette]);
				dearkArgs.push(state[imageType][imageName]);

				runUtil.run("deark", dearkArgs, runUtil.SILENT, this);
			},
			function addPreparedReference()
			{
				state.prepared[imageType][imageName] = path.join(prepDirPath, `${imageType}-${imageName}.000.png`);
				this();
			},
			subcb
		);
	}, cb);
}

function processLine(state, cb)
{
	if(state.f>=argv.maxFrames)
		return setImmediate(cb);

	const scriptLine = state.scriptLines[state.l];
	tiptoe(
		function parseLine()
		{
			const {labelName} = (scriptLine.match(/^(?<labelName>\S+):/) || {groups : {}}).groups;
			if(labelName)
			{
				if(state.labels[labelName])
					XU.log`Line ${state.l} has duplicate label ${labelName} which was already defined at l ine ${state.labels[labelName]}`;
				else
					state.labels[labelName] = state.l+1;
				
				return this();
			}

			const {cmdRaw, argRaw} = (scriptLine.match(/^(?<cmdRaw>\S+) ?(?<argRaw>.+)?\s*;?.*$/) || {groups : {}}).groups;
			if(!cmdRaw)
			{
				msg(state, `No command found: [${scriptLine}]`);
				return this();
			}

			const cmd = cmds[cmdRaw.toUpperCase()];
			if(!cmd)
			{
				if(state.l+1<state.scriptLines.length)
					msg(state, `Unsupported command: ${cmdRaw}`);
				return this();
			}

			cmd(argRaw, state, this);
		},
		function processNextLine(err, nextLine)
		{
			if(err)
				process.exit(XU.log`${XU.cf.fg.red("ERROR")} ${state.scriptName}@${state.l}: ${err}`);
			
			if(typeof nextLine!=="undefined")
				state.l = nextLine;
			else if(state.l+1===state.scriptLines.length)
				return setImmediate(cb);
			else
				state.l++;
			
			setImmediate(() => processLine(state, cb));
		}
	);
}

grasp2mp4(XU.FINISH);
