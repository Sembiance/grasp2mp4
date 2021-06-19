#!/usr/bin/env node
"use strict";
const XU = require("@sembiance/xu"),
	fileUtil = require("@sembiance/xutil").file,
	runUtil = require("@sembiance/xutil").run,
	cmdUtil = require("@sembiance/xutil").cmd,
	gd = require("node-gd"),
	fs = require("fs"),
	path = require("path"),
	util = require("util"),
	tiptoe = require("tiptoe");

const argv = cmdUtil.cmdInit({
	version     : "1.0.0",
	desc : "Convert a GRASP GL file into one or more MP4 files",
	opts        :
	{
		force       : {desc : "Overwrite any existing MP4 files in outDirPath"},
		keep        : {desc : "Keep temporary working files around"},
		quiet       : {desc : "Don't output any progress messages"},
		verbose     : {desc : "Be extra chatty"},
		speed       : {desc : "How fast to render the video", defaultValue : 150},
		maxDuration : {desc : "Maximum duration of video, in seconds", noShort : true, defaultValue : 300}
	},
	args :
	[
		{argid : "graspFilePath", desc : "Input grasp.gl file path", required : true},
		{argid : "outDirPath", desc : "Output directory", required : true}
	]});

const MAX_SPEED = 10000;	// max speed allowed in GRASP spec
const SLOWEST_FADE = XU.SECOND*3;

if(!fileUtil.existsSync(argv.graspFilePath))
	process.exit(XU.log`graspFilePath file path ${argv.graspFilePath} does not exist`);

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
			const baseState =
			{
				glFilesDirPath,
				outDirPath : argv.outDirPath,
				picPaths   : {},
				clipPaths  : {},
				wipDirPath
			};

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
					baseState.picPaths[fileNameNoExt] = newFilePath;
					baseState.picPaths[path.basename(newFilePath)] = newFilePath;
				}
				else if(glFileExt===".clp")
				{
					baseState.clipPaths[fileNameNoExt] = newFilePath;
					baseState.clipPaths[path.basename(newFilePath)] = newFilePath;
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

	state.l = 0;		// Current line being executed
	state.frames = [];	// An array of GD image frames to use for the video
	state.duration = 0;	// Current duration of video
	state.labels = {};	// label : lineNum
	state.marks = {};	// lineNum : count
	state.picBuf = {};	// Loaded GD images from PLOAD
	state.clipBuf = {};	// Loaded GD images from CLOAD

	tiptoe(
		function processLines()
		{
			processLine(state, this);
		},
		function writeFramesToDisk()
		{
			if(!argv.quiet)
				XU.log`Writing frames to disk...`;
			
			state.frames.parallelForEach((frame, subcb, i) => fs.writeFile(path.join(state.framesDirPath, `${i.toString().padStart(9, "0")}.png`), frame.pngPtr(), {encoding : null}, subcb), this);
		},
		function makeMovie()
		{
			if(!argv.quiet)
				XU.log`Making movie from frames...`;

			const ffmpegArgs = ["-r", argv.rate, "-f", "image2", "-s", state.video.resolution.join("x"), "-i", `%09d.png`];
			ffmpegArgs.push("-c:v", "libx264", "-crf", "15", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "faststart", path.resolve(outMP4FilePath));
			runUtil.run("ffmpeg", ffmpegArgs, {cwd : state.framesDirPath, silent : true}, this);
		},
		cb
	);
}

const msg = (state, msgData, cb) =>
{
	XU.log`${state.scriptName}@${state.l.toLocaleString().padStart(state.scriptLines.length.toLocaleString().length, " ")}: ${XU.cf.fg.white(msgData)}`;
	if(cb)
		setImmediate(cb);
};

const cmds = {};

// VIDEO mode - Switches screen video mode
cmds.VIDEO = (argRaw, state, cb) =>
{
	if(state.video)
		return msg(state, `VIDEO Changing video mode more than once is not currently supported`, cb);

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
	state.screen = gd.createTrueColorSync(...state.video.resolution);

	cb();
};

// PLOAD picName,bufNum - Load a picture into a picBuf
cmds.PLOAD = (argRaw, state, cb) =>
{
	const [imageName, bufNum] = argRaw.split(",").map(v => v.trim());
	loadImage(state, {imageName, bufNum}, "pic", cb);
};

// PALETTE bufNum - Set the current working pallete from a pic in picBuf
cmds.PALETTE = (argRaw, state, cb) =>
{
	const bufNum = argRaw.trim();
	if(!state.picBuf[bufNum])
		return msg(state, `PALETTE No pic buf loaded in ${bufNum} (${argRaw})`, cb);

	// Changing palettes, let's ditch any prepared clips/cips
	state.palette = state.picBuf[bufNum].originalPath;
	cb();
};

// PFREE bufNum, bufNum, bufNum... - Frees the given picture buffers
cmds.PFREE = (argRaw, state, cb) =>
{
	argRaw.split(",").map(v => v.trim()).forEach(bufNum =>
	{
		if(!state.picBuf[bufNum])
		{
			msg(state, `PFREE No pic buf loaded in ${bufNum} (${argRaw})`);
		}
		else
		{
			// TODO: state.picBuf[bufNum].image.destroy()
			delete state.picBuf[bufNum];
		}
	});

	cb();
};

// CLOAD clipName, bufNum, shiftParm - Loads a clip into a clipBuf
cmds.CLOAD = (argRaw, state, cb) =>
{
	const [imageName, bufNum] = argRaw.split(",").map(v => v.trim());
	loadImage(state, {imageName, bufNum}, "clip", cb);
};

// FLY startX, startY, endX, endY, increment, delay, clip1, clip2, ...clipn - Animate 1 or more clippings between two points on the screen
cmds.FLY = (argRaw, state, cb) =>
{
	const [startX, startY, endXRaw, endYRaw, increment, delay, ...clipNums] = argRaw.split(",").map(v => v.trim());

	const endX = +endXRaw;
	const endY = +endYRaw;
	let x = +startX;
	let y = +startY;
	let seenAllClips = false;
	const clipsLeft = Array.from(clipNums);
	for(;x!==endX || y!==endY || (!seenAllClips && clipsLeft.length>0);)
	{
		if(clipsLeft.length===0)
		{
			seenAllClips = true;
			clipsLeft.push(...clipNums);
		}

		if(startX<endX)
		{
			x += increment;
			x = Math.min(x, endX);
		}
		else if(startX>endX)
		{
			x -= Math.abs(increment);
			x = Math.max(x, endX);
		}

		if(startY<endY)
		{
			y += increment;
			y = Math.min(y, endY);
		}
		else if(startY>endY)
		{
			y -= Math.abs(increment);
			y = Math.max(y, endY);
		}

		const frame = gd.createFromPngPtr(state.screen.pngPtr());
		const clipImage = state.clipBuf[clipsLeft.shift()].image;
		clipImage.copy(frame, +x, +y, 0, 0, clipImage.width, clipImage.height);
		state.frames.push(frame);
	}
	
	cb();
};

// GOTO labelName - Jump to the given label in the program
cmds.GOTO = (argRaw, state, cb) =>
{
	const labelName = argRaw.trim();
	if(!state.labels.hasOwnProperty(labelName))
		return msg(state, `GOTO Label not found yet ${labelName}`, cb);
	
	if(argv.verbose)
		msg(state, `GOTO Jumping to label ${labelName} at line ${state.labels[labelName]}`);
	cb();	// TODO TEMPORARY
	//cb(undefined, state.labels[labelName]);
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

	if(argv.verbose)
		msg(state, `LOOP Looping back to ${targetMarkLine} with ${state.marks[targetMarkLine]} loops remaining...`);
	state.marks[targetMarkLine]--;
	cb(undefined, targetMarkLine);
};

// PFADE fadeNum, bufNum, speed, delay - Fades a picture to the screen
/*cmds.PFADE = (argRaw, state, cb) =>
{
	const [fadeNum, bufNum, speed=3000, delay=0] = argRaw.split(",").map(v => v.trim());	// eslint-disable-line no-unused-vars
	if(bufNum==="0")
	{
		if(!argv.quiet)
			msg(state, `PFADE Unsupported bufNum of 0`);
		
		return cb();
	}
	//#FFF7D7
	const fadeFrameCount = getFrameCountFromDuration(SLOWEST_FADE-speed.scale(0, MAX_SPEED, 0, SLOWEST_FADE));
	const frames = [].pushSequence(1, fadeFrameCount).map(i => ({x : 0, y : 0, imageFilePath : state.prepared.pics[state.picBuf[bufNum]].filePath, dissolve : i.scale(1, fadeFrameCount, 0, 1).ease("easeInSide").scale(0, 1, 0, 100)}));
	frames.serialForEach((frame, subcb) => writeFrame(state, frame, subcb), err => cb(err));
};*/

/*function writeFrame(state, frame, cb)
{
	const frameFilePath = getFrameFilePath(state);
	state.f++;

	const convertArgs = ["-size", state.video.resolution.join("x"), `xc:${state.backgroundColor}`, frame.imageFilePath, "-geometry", `+${frame.x}+${frame.y}`];
	if(frame.hasOwnProperty("dissolve"))
		convertArgs.push("-compose", "dissolve", "-define", `compose:args=${frame.dissolve.toString()}`);
	convertArgs.push("-composite", frameFilePath);
	state.cps.push(runUtil.run("convert", convertArgs, {silent : true, detached : true}));

	if(!frame.delay)
		return setImmediate(cb);

	const msPerFrame = (XU.SECOND/argv.rate);
	const delayFrameCount = Math.floor(((frame.delay || 0)*(XU.SECOND/argv.speed))/msPerFrame);
	if(delayFrameCount===0)
		return setImmediate(cb);

	[].pushSequence(0, delayFrameCount-1).serialForEach((i, subcb) =>
	{
		const symlinkFramePath = getFrameFilePath(state);
		state.f++;
		fs.symlink(path.basename(frameFilePath), symlinkFramePath, subcb);
	}, cb);
}*/

// Will pre-convert the given images into PNG, using state.palette if set
function loadImage(state, images, imageType, cb)
{
	const prepDirPath = fileUtil.generateTempFilePath(state.wipDirPath, "-loadImages");
	fs.mkdirSync(prepDirPath);

	Array.force(images).parallelForEach(({imageName, bufNum}, subcb) =>
	{
		tiptoe(
			function convertImage()
			{
				const dearkArgs = ["-od", prepDirPath, "-o", `${imageType}-${imageName}`, "-m", "pcpaint"];
				if(state.palette)
					dearkArgs.push("-file2", state.palette);
				dearkArgs.push(state[`${imageType}Paths`][imageName]);

				runUtil.run("deark", dearkArgs, runUtil.SILENT, this);
			},
			function loadIntoBuf()
			{
				const imageFilePath = path.join(prepDirPath, `${imageType}-${imageName}.000.png`);
				state[`${imageType}Buf`][bufNum] = {originalPath : state[`${imageType}Paths`][imageName], filePath : imageFilePath, image : gd.createFromPngPtr(fs.readFileSync(imageFilePath))};
				
				this();
			},
			subcb
		);
	}, err => cb(err), {atOnce : 20});
}

function processLine(state, cb)
{
	// TODO convert to duration
	//if(state.f>=argv.maxFrames)
	//	return setImmediate(cb);

	const scriptLine = state.scriptLines[state.l];
	tiptoe(
		function parseLine()
		{
			// First check to see if we are defining a label
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
			
			if(!["undefined", "number"].includes(typeof nextLine))
			{
				console.trace();
				process.exit(XU.log`${XU.cf.fg.red("ERROR")} ${state.scriptName}@${state.l}: Invalid nextLine returned`);
			}

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
