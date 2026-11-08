import { createLibrary } from '@openuidev/react-lang';
import { Box, Card, Col, Divider, Grid, Row, Spacer } from './components/layout';
import { Badge, Caption, Label, List, ListItem, Markdown, Text, Title } from './components/text';
import { Chart } from './components/chart';
import { Table } from './components/table';
import { svgComponents } from './components/svg';
import { Button, Select, SegmentedControl, Slider } from './components/controls';
import { functions } from './components/functions';

/** The same library defines the rendering surface and the model's generated schema. */
export const library = createLibrary({
  id: 'scholarlite-paper-visuals-v1', root: 'Col',
  components: [Col, Row, Box, Grid, Card, Divider, Spacer, Title, Text, Caption, Label, Badge,
    List, ListItem, Markdown, Table, Chart, Button, Select, SegmentedControl, Slider, ...svgComponents],
  functions,
  componentGroups: [
    {name:'Layout',components:['Col','Row','Box','Grid','Card','Divider','Spacer'],notes:[
      'gap and padding count 4px steps. Use Col for narrow reading sidebars; Grid should set minChildWidth. Avoid nesting cards.',
      'Color tokens: ink, muted, faint, surface, info, success, warning, danger, purple, pink, chart1 to chart6. Use tokens for dark mode.',
    ]},
    {name:'Text and evidence',components:['Title','Text','Caption','Label','Badge','List','ListItem','Markdown','Table']},
    {name:'Charts',components:['Chart'],notes:['Preserve original units and comparable conditions. Missing data is not zero. Put data provenance and units in adjacent Title/Caption.']},
    {name:'Local interactive exploration',components:['Button','Select','SegmentedControl','Slider'],notes:[
      'Controls bind to $variables. Display the result of each control. Calculations update locally without model calls.',
      '@ToAssistant only adds a follow-up draft for user review. Do not use @OpenUrl, @Run, Query or Mutation.',
    ]},
    {name:'Mechanism drawings',components:svgComponents.map(component=>component.name),notes:[
      'Use a compact viewBox (about 320 wide), readable labels and arrows. Never encode external assets or executable content.',
    ]},
  ],
});
