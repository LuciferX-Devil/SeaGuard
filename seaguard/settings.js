const path=require('path');
module.exports={uiHost:'127.0.0.1',uiPort:Number(process.env.SEAGUARD_PORT||1880),flowFile:path.join(__dirname,'flows.json'),logging:{console:{level:'info'}},functionGlobalContext:{rescue:require('./src/rescue/exercise.cjs'),rescueStore:require('./src/rescue/persistence.cjs').createStore({dataDir:path.join(__dirname,'data')})}};
