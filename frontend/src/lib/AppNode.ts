/**
 * @license
 * Copyright 2018-2021 Streamlit Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { produce } from "immer"
import { Map as ImmutableMap } from "immutable"
import Protobuf, {
  Arrow as ArrowProto,
  ArrowNamedDataSet,
  ArrowVegaLiteChart as ArrowVegaLiteChartProto,
  Block as BlockProto,
  Delta,
  Element,
  ForwardMsgMetadata,
  IArrow,
  IArrowNamedDataSet,
  NamedDataSet,
} from "src/autogen/proto"
import {
  VegaLiteChartElement,
  WrappedNamedDataset,
} from "src/components/elements/ArrowVegaLiteChart/ArrowVegaLiteChart"
import { Quiver } from "src/lib/Quiver"
import { addRows } from "./dataFrameProto"
import { toImmutableProto } from "./immutableProto"
import { MetricsManager } from "./MetricsManager"
import {
  makeElementWithInfoText,
  makeElementWithErrorText,
  notUndefined,
} from "./utils"

const NO_SESSION_ID = "NO_SESSION_ID"

/**
 * An immutable node of the "Report Data Tree".
 *
 * Trees are composed of `ElementNode` leaves, which contain data about
 * a single visual element, and `BlockNode` branches, which determine the
 * layout of a group of children nodes.
 *
 * A simple tree might look like this:
 *
 *   AppRoot
 *   ├── BlockNode ("main")
 *   │   ├── ElementNode (text: "Ahoy, Streamlit!")
 *   │   └── ElementNode (button: "Don't Push This")
 *   └── BlockNode ("sidebar")
 *       └── ElementNode (checkbox: "Batten The Hatches")
 *
 * To build this tree, the frontend receives `Delta` messages from Python,
 * each of which corresponds to a tree mutation ("add an element",
 * "add a block", "add rows to an existing element"). The frontend builds the
 * tree bit by bit in response to these `Delta`s.
 *
 * To render the app, the `AppView` class walks this tree and outputs
 * a corresponding DOM structure, using React, that's essentially a mapping
 * of `AppElement` -> `ReactNode`. This rendering happens "live" - that is,
 * the app is re-rendered each time a new `Delta` is received.
 *
 * Because the app gets re-rendered frequently, updates need to be fast.
 * Our React components - the building blocks of the app - are "pure"
 * (see https://reactjs.org/docs/react-api.html#reactpurecomponent), which
 * means that React uses shallow comparison to determine which ReactNodes to
 * update.
 *
 * Thus, each node in our tree is _immutable_ - any change to a `AppNode`
 * actually results in a *new* `AppNode` instance. This occurs recursively,
 * so inserting a new `ElementNode` into the tree will also result in new
 * `BlockNode`s for each of that Element's ancestors, all the way up to the
 * root node. Then, when React re-renders the app, it will re-traverse the new
 * nodes that have been created, and rebuild just the bits of the app that
 * have changed.
 */
export interface AppNode {
  /**
   * The ID of the report this node was generated in. When a report finishes
   * running, the app prunes all stale nodes.
   */
  readonly sessionId: string

  /**
   * Return the AppNode for the given index path, or undefined if the path
   * is invalid.
   */
  getIn(path: number[]): AppNode | undefined

  /**
   * Return a copy of this node with a new element set at the given index
   * path. Throws an error if the path is invalid.
   */
  setIn(path: number[], node: AppNode, sessionId: string): AppNode

  /**
   * Recursively remove children nodes whose reportID is no longer current.
   * If this node should no longer exist, return undefined.
   */
  clearStaleNodes(currentSessionId: string): AppNode | undefined

  /**
   * Return a Set of all the Elements contained in the tree.
   * If an existing Set is passed in, that Set will be mutated and returned.
   * Otherwise, a new Set will be created and will be returned.
   */
  getElements(elementSet?: Set<Element>): Set<Element>
}

/**
 * A leaf AppNode. Contains a single element to render.
 */
export class ElementNode implements AppNode {
  public readonly element: Element

  public readonly metadata: ForwardMsgMetadata

  public readonly sessionId: string

  /**
   * A lazily-created immutableJS version of our element.
   *
   * This is temporary! `immutableElement` is currently needed for
   * dataframe-consuming elements because our dataframe API is
   * immutableJS-based. It'll go away when we've converted to an ArrowJS-based
   * dataframe API.
   *
   * Because most elements do *not* use the Dataframe API, and therefore
   * do not need to access `immutableElement`, it is calculated lazily.
   */
  private lazyImmutableElement?: ImmutableMap<string, any>

  private lazyQuiverElement?: Quiver

  private lazyVegaLiteChartElement?: VegaLiteChartElement

  /** Create a new ElementNode. */
  public constructor(
    element: Element,
    metadata: ForwardMsgMetadata,
    sessionId: string
  ) {
    this.element = element
    this.metadata = metadata
    this.sessionId = sessionId
  }

  public get immutableElement(): ImmutableMap<string, any> {
    if (this.lazyImmutableElement !== undefined) {
      return this.lazyImmutableElement
    }

    const toReturn = toImmutableProto(Element, this.element)
    this.lazyImmutableElement = toReturn
    return toReturn
  }

  public get quiverElement(): Quiver {
    if (this.lazyQuiverElement !== undefined) {
      return this.lazyQuiverElement
    }

    if (
      this.element.type !== "arrowTable" &&
      this.element.type !== "arrowDataFrame"
    ) {
      throw new Error(
        `elementType '${this.element.type}' is not a valid Quiver element!`
      )
    }

    const toReturn = new Quiver(this.element[this.element.type] as ArrowProto)

    this.lazyQuiverElement = toReturn
    return toReturn
  }

  public get vegaLiteChartElement(): VegaLiteChartElement {
    if (this.lazyVegaLiteChartElement !== undefined) {
      return this.lazyVegaLiteChartElement
    }

    if (this.element.type !== "arrowVegaLiteChart") {
      throw new Error(
        `elementType '${this.element.type}' is not a valid VegaLiteChartElement!`
      )
    }

    const proto = this.element.arrowVegaLiteChart as ArrowVegaLiteChartProto
    const modifiedData = proto.data ? new Quiver(proto.data) : null
    const modifiedDatasets =
      proto.datasets.length > 0 ? wrapDatasets(proto.datasets) : []

    const toReturn = {
      data: modifiedData,
      spec: proto.spec,
      datasets: modifiedDatasets,
      useContainerWidth: proto.useContainerWidth,
    }

    this.lazyVegaLiteChartElement = toReturn
    return toReturn
  }

  // eslint-disable-next-line class-methods-use-this
  public getIn(path: number[]): AppNode | undefined {
    return undefined
  }

  // eslint-disable-next-line class-methods-use-this
  public setIn(path: number[], node: AppNode, sessionId: string): AppNode {
    throw new Error("'setIn' cannot be called on an ElementNode")
  }

  public clearStaleNodes(currentSessionId: string): ElementNode | undefined {
    return this.sessionId === currentSessionId ? this : undefined
  }

  public getElements(elements?: Set<Element>): Set<Element> {
    if (elements == null) {
      elements = new Set<Element>()
    }
    elements.add(this.element)
    return elements
  }

  public addRows(namedDataSet: NamedDataSet, sessionId: string): ElementNode {
    const newNode = new ElementNode(this.element, this.metadata, sessionId)
    newNode.lazyImmutableElement = addRows(
      this.immutableElement,
      toImmutableProto(NamedDataSet, namedDataSet)
    )
    return newNode
  }

  public arrowAddRows(
    namedDataSet: ArrowNamedDataSet,
    sessionId: string
  ): ElementNode {
    const elementType = this.element.type
    const newNode = new ElementNode(this.element, this.metadata, sessionId)

    switch (elementType) {
      case "arrowTable":
      case "arrowDataFrame": {
        newNode.lazyQuiverElement = ElementNode.quiverAddRowsHelper(
          this.quiverElement,
          namedDataSet
        )
        break
      }
      case "arrowVegaLiteChart": {
        newNode.lazyVegaLiteChartElement = ElementNode.vegaLiteChartAddRowsHelper(
          this.vegaLiteChartElement,
          namedDataSet
        )
        break
      }
      default: {
        // This should never happen!
        throw new Error(
          `elementType '${this.element.type}' is not a valid arrowAddRows target!`
        )
      }
    }

    return newNode
  }

  private static quiverAddRowsHelper(
    element: Quiver,
    namedDataSet: ArrowNamedDataSet
  ): Quiver {
    if (namedDataSet.hasName) {
      throw new Error(
        "Add rows cannot be used with a named dataset for this element."
      )
    }

    const newQuiver = new Quiver(namedDataSet.data as IArrow)
    return element.addRows(newQuiver)
  }

  private static vegaLiteChartAddRowsHelper(
    element: VegaLiteChartElement,
    namedDataSet: ArrowNamedDataSet
  ): VegaLiteChartElement {
    const newDataSetName = namedDataSet.hasName ? namedDataSet.name : null
    const newDataSetQuiver = new Quiver(namedDataSet.data as IArrow)

    return produce(element, (draft: VegaLiteChartElement) => {
      const existingDataSet = getNamedDataSet(draft.datasets, newDataSetName)
      if (existingDataSet) {
        existingDataSet.data = existingDataSet.data.addRows(newDataSetQuiver)
      } else {
        draft.data = draft.data
          ? draft.data.addRows(newDataSetQuiver)
          : newDataSetQuiver
      }
    })
  }
}

/**
 * If there is only one NamedDataSet, return it.
 * If there is a NamedDataset that matches the given name, return it.
 * Otherwise, return `undefined`.
 */
function getNamedDataSet(
  namedDataSets: WrappedNamedDataset[],
  name: string | null
): WrappedNamedDataset | undefined {
  if (namedDataSets.length === 1) {
    return namedDataSets[0]
  }

  return namedDataSets.find(
    (dataset: WrappedNamedDataset) => dataset.hasName && dataset.name === name
  )
}

/**
 * A container AppNode that holds children.
 */
export class BlockNode implements AppNode {
  public readonly children: AppNode[]

  public readonly deltaBlock: BlockProto

  public readonly sessionId: string

  public constructor(
    children?: AppNode[],
    deltaBlock?: BlockProto,
    sessionId?: string
  ) {
    this.children = children ?? []
    this.deltaBlock = deltaBlock ?? new BlockProto({})
    this.sessionId = sessionId ?? NO_SESSION_ID
  }

  /** True if this Block has no children. */
  public get isEmpty(): boolean {
    return this.children.length === 0
  }

  public getIn(path: number[]): AppNode | undefined {
    if (path.length === 0) {
      return undefined
    }

    const childIndex = path[0]
    if (childIndex < 0 || childIndex >= this.children.length) {
      return undefined
    }

    if (path.length === 1) {
      return this.children[childIndex]
    }

    return this.children[childIndex].getIn(path.slice(1))
  }

  public setIn(path: number[], node: AppNode, sessionId: string): BlockNode {
    if (path.length === 0) {
      throw new Error(`empty path!`)
    }

    const childIndex = path[0]
    if (childIndex < 0 || childIndex > this.children.length) {
      throw new Error(
        `Bad 'setIn' index ${childIndex} (should be between [0, ${this.children.length}])`
      )
    }

    const newChildren = this.children.slice()
    if (path.length === 1) {
      // Base case
      newChildren[childIndex] = node
    } else {
      // Pop the current element off our path, and recurse into our children
      newChildren[childIndex] = newChildren[childIndex].setIn(
        path.slice(1),
        node,
        sessionId
      )
    }

    return new BlockNode(newChildren, this.deltaBlock, sessionId)
  }

  public clearStaleNodes(currentSessionId: string): BlockNode | undefined {
    if (this.sessionId !== currentSessionId) {
      return undefined
    }

    // Recursively clear our children.
    const newChildren = this.children
      .map(child => child.clearStaleNodes(currentSessionId))
      .filter(notUndefined)

    // If we have no children and our `allowEmpty` flag is not set, prune
    // ourselves!
    if (newChildren.length === 0 && !this.deltaBlock.allowEmpty) {
      return undefined
    }

    return new BlockNode(newChildren, this.deltaBlock, currentSessionId)
  }

  public getElements(elementSet?: Set<Element>): Set<Element> {
    if (elementSet == null) {
      elementSet = new Set<Element>()
    }

    for (const child of this.children) {
      child.getElements(elementSet)
    }

    return elementSet
  }
}

/**
 * The root of our data tree. It contains the app's top-level BlockNodes.
 */
export class AppRoot {
  private readonly root: BlockNode

  /**
   * Create an empty AppRoot with an optional placeholder element.
   */
  public static empty(placeholderText?: string): AppRoot {
    let mainNodes: AppNode[]
    if (placeholderText != null) {
      const waitNode = new ElementNode(
        makeElementWithInfoText(placeholderText),
        ForwardMsgMetadata.create({}),
        NO_SESSION_ID
      )
      mainNodes = [waitNode]
    } else {
      mainNodes = []
    }

    const main = new BlockNode(
      mainNodes,
      new BlockProto({ allowEmpty: true }),
      NO_SESSION_ID
    )

    const sidebar = new BlockNode(
      [],
      new BlockProto({ allowEmpty: true }),
      NO_SESSION_ID
    )

    return new AppRoot(new BlockNode([main, sidebar]))
  }

  public constructor(root: BlockNode) {
    this.root = root

    // Verify that our root node has exactly 2 children: a 'main' block and
    // a 'sidebar' block.
    if (
      this.root.children.length !== 2 ||
      this.main == null ||
      this.sidebar == null
    ) {
      throw new Error(`Invalid root node children! ${root}`)
    }
  }

  public get main(): BlockNode {
    return this.root.children[Protobuf.RootContainer.MAIN] as BlockNode
  }

  public get sidebar(): BlockNode {
    return this.root.children[Protobuf.RootContainer.SIDEBAR] as BlockNode
  }

  public applyDelta(
    sessionId: string,
    delta: Delta,
    metadata: ForwardMsgMetadata
  ): AppRoot {
    // The full path to the AppNode within the element tree.
    // Used to find and update the element node specified by this Delta.
    const { deltaPath } = metadata

    // Update Metrics
    MetricsManager.current.incrementDeltaCounter(
      getRootContainerName(deltaPath)
    )

    switch (delta.type) {
      case "newElement": {
        const element = delta.newElement as Element
        if (element.type != null) {
          MetricsManager.current.incrementDeltaCounter(element.type)
        }

        // Track component instance name.
        if (element.type === "componentInstance") {
          const componentName = element.componentInstance?.componentName
          if (componentName != null) {
            MetricsManager.current.incrementCustomComponentCounter(
              componentName
            )
          }
        }

        return this.addElement(deltaPath, sessionId, element, metadata)
      }

      case "addBlock": {
        MetricsManager.current.incrementDeltaCounter("new block")
        return this.addBlock(
          deltaPath,
          delta.addBlock as BlockProto,
          sessionId
        )
      }

      case "addRows": {
        MetricsManager.current.incrementDeltaCounter("add rows")
        return this.addRows(
          deltaPath,
          delta.addRows as NamedDataSet,
          sessionId
        )
      }

      case "arrowAddRows": {
        MetricsManager.current.incrementDeltaCounter("arrow add rows")
        try {
          return this.arrowAddRows(
            deltaPath,
            delta.arrowAddRows as ArrowNamedDataSet,
            sessionId
          )
        } catch (error) {
          const errorElement = makeElementWithErrorText(error.message)
          return this.addElement(deltaPath, sessionId, errorElement, metadata)
        }
      }

      default: {
        throw new Error(`Unrecognized deltaType: '${delta.type}'`)
      }
    }
  }

  public clearStaleNodes(currentSessionId: string): AppRoot {
    const main = this.main.clearStaleNodes(currentSessionId) || new BlockNode()
    const sidebar =
      this.sidebar.clearStaleNodes(currentSessionId) || new BlockNode()

    return new AppRoot(
      new BlockNode(
        [main, sidebar],
        new BlockProto({ allowEmpty: true }),
        currentSessionId
      )
    )
  }

  /** Return a Set containing all Elements in the tree. */
  public getElements(): Set<Element> {
    const elements = new Set<Element>()
    this.main.getElements(elements)
    this.sidebar.getElements(elements)
    return elements
  }

  private addElement(
    deltaPath: number[],
    sessionId: string,
    element: Element,
    metadata: ForwardMsgMetadata
  ): AppRoot {
    const elementNode = new ElementNode(element, metadata, sessionId)
    return new AppRoot(this.root.setIn(deltaPath, elementNode, sessionId))
  }

  private addBlock(
    deltaPath: number[],
    block: BlockProto,
    sessionId: string
  ): AppRoot {
    const existingNode = this.root.getIn(deltaPath)

    // If we're replacing an existing Block, this new Block inherits
    // the existing Block's children. This prevents existing widgets from
    // having their values reset.
    const children: AppNode[] =
      existingNode instanceof BlockNode ? existingNode.children : []

    const blockNode = new BlockNode(children, block, sessionId)
    return new AppRoot(this.root.setIn(deltaPath, blockNode, sessionId))
  }

  private addRows(
    deltaPath: number[],
    namedDataSet: NamedDataSet,
    sessionId: string
  ): AppRoot {
    const existingNode = this.root.getIn(deltaPath) as ElementNode
    if (existingNode == null) {
      throw new Error(`Can't addRows: invalid deltaPath: ${deltaPath}`)
    }

    const elementNode = existingNode.addRows(namedDataSet, sessionId)
    return new AppRoot(this.root.setIn(deltaPath, elementNode, sessionId))
  }

  private arrowAddRows(
    deltaPath: number[],
    namedDataSet: ArrowNamedDataSet,
    sessionId: string
  ): AppRoot {
    const existingNode = this.root.getIn(deltaPath) as ElementNode
    if (existingNode == null) {
      throw new Error(`Can't arrowAddRows: invalid deltaPath: ${deltaPath}`)
    }

    const elementNode = existingNode.arrowAddRows(namedDataSet, sessionId)
    return new AppRoot(this.root.setIn(deltaPath, elementNode, sessionId))
  }
}

function getRootContainerName(deltaPath: number[]): string {
  if (deltaPath.length > 0) {
    switch (deltaPath[0]) {
      case Protobuf.RootContainer.MAIN:
        return "main"
      case Protobuf.RootContainer.SIDEBAR:
        return "sidebar"
      default:
        break
    }
  }

  throw new Error(`Unrecognized RootContainer in deltaPath: ${deltaPath}`)
}

/** Iterates over datasets and converts data to Quiver. */
function wrapDatasets(datasets: IArrowNamedDataSet[]): WrappedNamedDataset[] {
  return datasets.map((dataset: IArrowNamedDataSet) => {
    return {
      hasName: dataset.hasName as boolean,
      name: dataset.name as string,
      data: new Quiver(dataset.data as IArrow),
    }
  })
}
